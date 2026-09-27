/**
 * Refund-request workflow: load the facts, run the policy engine + AI layer,
 * and persist the decision with its full reasoning trace.
 */
import { MODEL, type AssessmentResult, type FinalDecision, type RefundContext } from "../aiLayer";
import type { Db } from "../db";
import { conflict, notFound } from "../errors";
import { Prisma } from "../generated/prisma/client";
import type { RefundReason, RefundStatus } from "../generated/prisma/enums";
import { customerMessage } from "./customerMessage";

/** The part of the AI layer the service depends on (injectable for tests). */
export interface RefundAssessor {
  assessRefundRequest(ctx: RefundContext): Promise<AssessmentResult>;
}

export interface ServiceDeps {
  prisma: Db;
  assessor: RefundAssessor;
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
      model: string;
      outcome: "assessment" | "unavailable";
      recommendation?: string;
      confidence?: number;
      reasoning?: string;
      flags?: string[];
      error?: string;
    }
  | { stage: "final"; decision: FinalDecision; source: string; conflict: string | null };

const INJECTION_PREFIX = "injection:";

export function injectionLabels(flags: readonly string[]): string[] {
  return flags.filter((f) => f.startsWith(INJECTION_PREFIX)).map((f) => f.slice(INJECTION_PREFIX.length));
}

/** Failure codes the AI layer records when Claude could not be used (ai_api_error_500, ...). */
const aiErrors = (flags: readonly string[]) => flags.filter((f) => f.startsWith("ai_")).join(", ");

/** Turns an AssessmentResult into the ordered trace stored with the request. */
export function buildReasoningLog(result: AssessmentResult, model = MODEL): ReasoningStep[] {
  const labels = injectionLabels(result.flags);
  const steps: ReasoningStep[] = [
    { stage: "policy_engine", decision: result.policy.decision, rule: result.policy.rule, reasons: result.policy.reasons },
    { stage: "injection_scan", detected: labels.length > 0, labels },
  ];

  switch (result.source) {
    case "policy_engine":
      steps.push({
        stage: "ai",
        consulted: false,
        skippedBecause:
          result.policy.decision === "APPROVE"
            ? "Clear-cut request; no judgment needed"
            : "Policy engine decision is final",
      });
      break;
    case "injection_guard":
      steps.push({ stage: "ai", consulted: false, skippedBecause: "Possible prompt injection; escalated to a human" });
      break;
    case "ai_assisted":
      steps.push({
        stage: "ai",
        consulted: true,
        model,
        outcome: "assessment",
        recommendation: result.ai?.recommendedDecision,
        confidence: result.ai?.confidence,
        reasoning: result.ai?.reasoning,
        flags: result.ai?.flags,
      });
      break;
    case "ai_unavailable":
      steps.push({ stage: "ai", consulted: true, model, outcome: "unavailable", error: aiErrors(result.flags) });
      break;
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
      return `Escalated for human review: AI assessment unavailable (${aiErrors(result.flags)})`;
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

export async function listCustomers(prisma: Db) {
  return prisma.customer.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, email: true } });
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

/** Decision columns written for a new or re-run request. */
function decisionData(
  result: AssessmentResult,
  facts: {
    order: Parameters<typeof customerMessage>[0]["order"];
    request: Parameters<typeof customerMessage>[0]["request"];
    asOf: Date;
    decidedAt: Date;
    extraSteps?: ReasoningStep[];
  },
) {
  return {
    status: STATUS[result.decision],
    resolvedAt: result.decision === "escalated" ? null : facts.decidedAt,
    decisionNotes: decisionSummary(result),
    customerMessage: customerMessage({
      decision: result.decision,
      rule: result.policy.rule,
      order: facts.order,
      request: facts.request,
      now: facts.asOf,
    }),
    decisionSource: result.source,
    injectionDetected: injectionLabels(result.flags).length > 0,
    flags: result.flags,
    reasoningLog: [...(facts.extraSteps ?? []), ...buildReasoningLog(result)] as unknown as Prisma.InputJsonValue,
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

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.refundRequest.create({
      data: {
        orderId: order.id,
        customerId: customer.id,
        reason: request.reason,
        description: request.description,
        amountCents: request.amountCents,
        requestedAt: now,
        ...decisionData(result, { order, request, asOf: now, decidedAt: now }),
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
    throw conflict(`Refund request ${id} is ${existing.status.toLowerCase()}; only pending or escalated requests can be re-run`);
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

  await prisma.$transaction(async (tx) => {
    // Only update if still open, so two staff re-running at once can't both decide it.
    const { count } = await tx.refundRequest.updateMany({
      where: { id, status: { in: OPEN_STATUSES } },
      data: decisionData(result, { order, request, asOf, decidedAt, extraSteps: [rerunStep] }),
    });
    if (count === 0) throw conflict(`Refund request ${id} was decided by someone else in the meantime`);
    if (result.decision === "approved") {
      await tx.order.update({ where: { id: order.id }, data: { status: "REFUNDED" } });
    }
  });

  return getRefundRequest(prisma, id);
}
