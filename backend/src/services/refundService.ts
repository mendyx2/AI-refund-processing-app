/**
 * Refund-request workflow: load the facts, run the policy engine + AI layer,
 * and persist the decision with its full reasoning trace.
 */
import type { AiMode, AssessmentResult, FinalDecision, RefundContext } from "../aiLayer";
import type { Db } from "../db";
import { conflict, notFound } from "../errors";
import { Prisma } from "../generated/prisma/client";
import type { RefundReason, RefundStatus } from "../generated/prisma/enums";
import type { AssistOutcome, ReasonSuggestion, ReplyInput } from "../ai/assist";
import { customerMessage } from "./customerMessage";

/** The part of the AI layer the service depends on (injectable for tests). */
export interface RefundAssessor {
  assessRefundRequest(ctx: RefundContext): Promise<AssessmentResult>;
}

/** Customer-facing AI help (ai/assist.ts); optional, everything falls back to templates. */
export interface CustomerAssist {
  readonly providerName: string;
  readonly model: string;
  writeReply(input: ReplyInput): Promise<AssistOutcome<string>>;
  suggestReason(
    order: { productName: string; category: string; status: string },
    message: string,
  ): Promise<{ ok: ReasonSuggestion } | { error: string }>;
}

export interface ServiceDeps {
  prisma: Db;
  assessor: RefundAssessor;
  assistant?: CustomerAssist;
  now?: () => Date;
}

export interface SubmitRefundInput {
  customerId: number;
  orderId: number;
  message: string;
  reason: RefundReason;
  /** Defaults to the full order total. */
  amountCents?: number;
}

// ---------------------------------------------------------------------------
// Reasoning trace
// ---------------------------------------------------------------------------

export type ReasoningStep =
  | {
      stage: "rerun";
      at: string;
      /** Policy is evaluated as of the original request time. */
      evaluatedAsOf: string;
      previousStatus: string;
      previousSource: string | null;
    }
  | { stage: "policy_engine"; decision: string; rule: string; reasons: string[] }
  | { stage: "injection_scan"; detected: boolean; labels: string[] }
  | {
      stage: "ai";
      consulted: false;
      skippedBecause: string;
    }
  | {
      stage: "ai";
      consulted: true;
      /** anthropic | openai | gemini | openai-compatible | none */
      provider: string;
      model: string;
      /** assessment: rule-approved request; consistency_check: reason-dependent denial. */
      mode: AiMode;
      outcome: "assessment" | "unavailable";
      recommendation?: string;
      confidence?: number;
      reasoning?: string;
      flags?: string[];
      error?: string;
    }
  | { stage: "final"; decision: FinalDecision; source: string; conflict: string | null }
  | {
      stage: "reply";
      /** Who wrote the customer-facing reply. The decision itself is unaffected. */
      by: "ai" | "template";
      provider?: string;
      model?: string;
      /** Why the template was used (AI unavailable, injection suspected, reply rejected, ...). */
      reason?: string;
    };

const INJECTION_PREFIX = "injection:";

export function injectionLabels(flags: readonly string[]): string[] {
  return flags.filter((f) => f.startsWith(INJECTION_PREFIX)).map((f) => f.slice(INJECTION_PREFIX.length));
}

/** Turns an AssessmentResult into the ordered trace stored with the request. */
export function buildReasoningLog(result: AssessmentResult): ReasoningStep[] {
  const labels = injectionLabels(result.flags);
  const steps: ReasoningStep[] = [
    {
      stage: "policy_engine",
      decision: result.policy.decision,
      rule: result.policy.rule,
      reasons: result.policy.reasons,
    },
    { stage: "injection_scan", detected: labels.length > 0, labels },
  ];

  const ai = result.aiStep;
  if (!ai.consulted) {
    steps.push({ stage: "ai", consulted: false, skippedBecause: ai.skippedBecause });
  } else if (ai.error) {
    steps.push({
      stage: "ai",
      consulted: true,
      provider: ai.provider,
      model: ai.model,
      mode: ai.mode,
      outcome: "unavailable",
      error: ai.error,
    });
  } else {
    steps.push({
      stage: "ai",
      consulted: true,
      provider: ai.provider,
      model: ai.model,
      mode: ai.mode,
      outcome: "assessment",
      recommendation: result.ai?.recommendedDecision,
      confidence: result.ai?.confidence,
      reasoning: result.ai?.reasoning,
      flags: result.ai?.flags,
    });
  }

  steps.push({ stage: "final", decision: result.decision, source: result.source, conflict: result.conflict });
  return steps;
}

/** One-line human-readable summary stored in decisionNotes. */
export function decisionSummary(result: AssessmentResult): string {
  switch (result.source) {
    case "ai_assisted":
      return result.ai?.reasoning ?? result.policy.reasons.join("; ");
    case "injection_guard":
      return `Escalated for human review: possible prompt injection (${injectionLabels(result.flags).join(", ")})`;
    case "ai_unavailable":
      return `Escalated for human review: AI assessment unavailable (${result.aiStep.consulted ? result.aiStep.error : ""})`;
    case "policy_engine":
      return result.policy.reasons.join("; ");
  }
}

const STATUS: Record<FinalDecision, RefundStatus> = {
  approved: "APPROVED",
  denied: "DENIED",
  escalated: "ESCALATED",
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const detailInclude = {
  customer: { select: { id: true, name: true, email: true } },
  order: true,
} satisfies Prisma.RefundRequestInclude;

export async function getRefundRequest(prisma: Db, id: number) {
  const request = await prisma.refundRequest.findUnique({ where: { id }, include: detailInclude });
  if (!request) throw notFound(`Refund request ${id} not found`);
  return request;
}

export async function listRefundRequests(prisma: Db, filter: { status?: RefundStatus } = {}) {
  return prisma.refundRequest.findMany({
    where: filter.status ? { status: filter.status } : undefined,
    orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      status: true,
      reason: true,
      amountCents: true,
      requestedAt: true,
      resolvedAt: true,
      decisionSource: true,
      injectionDetected: true,
      flags: true,
      customer: { select: { id: true, name: true, email: true } },
      order: { select: { id: true, orderNumber: true, productName: true, totalCents: true } },
    },
  });
}

/**
 * Guest order lookup: the customer whose email matches AND who owns an order
 * with this number, or null. Case- and whitespace-insensitive. Callers must
 * not reveal which half failed.
 */
export async function findCustomerForSignIn(prisma: Db, email: string, orderNumber: string) {
  const order = await prisma.order.findUnique({
    where: { orderNumber: orderNumber.trim().toUpperCase() },
    select: { customer: { select: { id: true, name: true, email: true } } },
  });
  if (!order || order.customer.email.toLowerCase() !== email.trim().toLowerCase()) return null;
  return order.customer;
}

export async function getCustomerOrders(prisma: Db, customerId: number) {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: {
      id: true,
      name: true,
      email: true,
      orders: {
        orderBy: [{ orderedAt: "desc" }, { id: "desc" }],
        include: {
          refundRequests: {
            orderBy: { requestedAt: "desc" },
            select: { id: true, status: true, reason: true, amountCents: true, requestedAt: true },
          },
        },
      },
    },
  });
  if (!customer) throw notFound(`Customer ${customerId} not found`);
  return customer;
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

const OPEN_STATUSES: RefundStatus[] = ["PENDING", "ESCALATED"];

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * The customer-facing reply: the rule-based template, optionally rewritten by
 * the AI assistant in a warmer tone. The template is used whenever the AI is
 * unavailable, the customer's text looked like an injection attempt, or the
 * AI's reply failed validation.
 */
async function customerReply(
  deps: ServiceDeps,
  result: AssessmentResult,
  facts: {
    customerName: string;
    order: Parameters<typeof customerMessage>[0]["order"];
    request: Parameters<typeof customerMessage>[0]["request"] & { description: string | null };
    asOf: Date;
  },
): Promise<{ text: string; step: ReasoningStep }> {
  const template = customerMessage({
    decision: result.decision,
    rule: result.policy.rule,
    order: facts.order,
    request: facts.request,
    now: facts.asOf,
  });
  const templated = (reason: string): { text: string; step: ReasoningStep } => ({
    text: template,
    step: { stage: "reply", by: "template", reason },
  });

  if (!deps.assistant) return templated("No AI assistant configured");
  if (result.source === "injection_guard" || injectionLabels(result.flags).length > 0) {
    return templated("Possible prompt injection; AI not used for the reply");
  }

  const outcome = await deps.assistant.writeReply({
    firstName: facts.customerName.split(/\s+/)[0] ?? facts.customerName,
    productName: facts.order.productName,
    decision: result.decision,
    approvedMessage: template,
    amountText: result.decision === "approved" ? money(facts.request.amountCents) : undefined,
    customerMessage: facts.request.description,
  });
  if ("error" in outcome) return templated(outcome.error);
  return {
    text: outcome.ok,
    step: { stage: "reply", by: "ai", provider: deps.assistant.providerName, model: deps.assistant.model },
  };
}

/** Decision columns written for a new or re-run request. */
function decisionData(
  result: AssessmentResult,
  facts: {
    decidedAt: Date;
    reply: { text: string; step: ReasoningStep };
    extraSteps?: ReasoningStep[];
  },
) {
  return {
    status: STATUS[result.decision],
    resolvedAt: result.decision === "escalated" ? null : facts.decidedAt,
    decisionNotes: decisionSummary(result),
    customerMessage: facts.reply.text,
    decisionSource: result.source,
    injectionDetected: injectionLabels(result.flags).length > 0,
    flags: result.flags,
    reasoningLog: [
      ...(facts.extraSteps ?? []),
      ...buildReasoningLog(result),
      facts.reply.step,
    ] as unknown as Prisma.InputJsonValue,
  } satisfies Prisma.RefundRequestUpdateInput;
}

export async function submitRefundRequest(deps: ServiceDeps, input: SubmitRefundInput) {
  const { prisma, assessor } = deps;
  const now = (deps.now ?? (() => new Date()))();

  const customer = await prisma.customer.findUnique({ where: { id: input.customerId } });
  if (!customer) throw notFound(`Customer ${input.customerId} not found`);

  const order = await prisma.order.findUnique({ where: { id: input.orderId } });
  // Same 404 whether the order is missing or belongs to someone else.
  if (!order || order.customerId !== customer.id) {
    throw notFound(`Order ${input.orderId} not found for customer ${customer.id}`);
  }

  const open = await prisma.refundRequest.findFirst({
    where: { orderId: order.id, status: { in: OPEN_STATUSES } },
    select: { id: true },
  });
  if (open) throw conflict(`Order ${order.orderNumber} already has an open refund request (#${open.id})`);

  const history = await prisma.refundRequest.findMany({
    where: { customerId: customer.id },
    select: { requestedAt: true, reason: true, status: true },
  });

  const request = {
    reason: input.reason,
    amountCents: input.amountCents ?? order.totalCents,
    description: input.message,
    requestedAt: now,
  };

  const result = await assessor.assessRefundRequest({
    customer: { name: customer.name, email: customer.email },
    order,
    request,
    customerRequests: [...history, { requestedAt: now, reason: input.reason }],
    now,
  });

  const reply = await customerReply(deps, result, { customerName: customer.name, order, request, asOf: now });

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.refundRequest.create({
      data: {
        orderId: order.id,
        customerId: customer.id,
        reason: request.reason,
        description: request.description,
        amountCents: request.amountCents,
        requestedAt: now,
        ...decisionData(result, { decidedAt: now, reply }),
      },
    });
    if (result.decision === "approved") {
      await tx.order.update({ where: { id: order.id }, data: { status: "REFUNDED" } });
    }
    return row;
  });

  return getRefundRequest(prisma, created.id);
}

/**
 * Staff action: runs an open (pending or escalated) request through the
 * pipeline again, e.g. a seeded request, or one escalated while Claude was
 * unavailable. The policy is evaluated as of the original request time, so a
 * late re-run can't push a request outside its refund window. Approved and
 * denied requests are final.
 */
export async function rerunRefundRequest(deps: ServiceDeps, id: number) {
  const { prisma, assessor } = deps;
  const decidedAt = (deps.now ?? (() => new Date()))();

  const existing = await prisma.refundRequest.findUnique({ where: { id }, include: { customer: true, order: true } });
  if (!existing) throw notFound(`Refund request ${id} not found`);
  if (!OPEN_STATUSES.includes(existing.status)) {
    throw conflict(
      `Refund request ${id} is ${existing.status.toLowerCase()}; only pending or escalated requests can be re-run`,
    );
  }

  // Includes this request itself, at its original time.
  const history = await prisma.refundRequest.findMany({
    where: { customerId: existing.customerId },
    select: { requestedAt: true, reason: true, status: true },
  });

  const asOf = existing.requestedAt;
  const { order, customer } = existing;
  const request = {
    reason: existing.reason,
    amountCents: existing.amountCents,
    description: existing.description,
    requestedAt: existing.requestedAt,
  };

  const result = await assessor.assessRefundRequest({
    customer: { name: customer.name, email: customer.email },
    order,
    request,
    customerRequests: history,
    now: asOf,
  });

  const rerunStep: ReasoningStep = {
    stage: "rerun",
    at: decidedAt.toISOString(),
    evaluatedAsOf: asOf.toISOString(),
    previousStatus: existing.status,
    previousSource: existing.decisionSource,
  };

  const reply = await customerReply(deps, result, { customerName: customer.name, order, request, asOf });

  await prisma.$transaction(async (tx) => {
    // Only update if still open, so two staff re-running at once can't both decide it.
    const { count } = await tx.refundRequest.updateMany({
      where: { id, status: { in: OPEN_STATUSES } },
      data: decisionData(result, { decidedAt, reply, extraSteps: [rerunStep] }),
    });
    if (count === 0) throw conflict(`Refund request ${id} was decided by someone else in the meantime`);
    if (result.decision === "approved") {
      await tx.order.update({ where: { id: order.id }, data: { status: "REFUNDED" } });
    }
  });

  return getRefundRequest(prisma, id);
}
