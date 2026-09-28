/** Typed client for the Express refund API (backend/src/routes). */

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export type RefundReason =
  | "DEFECTIVE"
  | "DAMAGED_IN_TRANSIT"
  | "WRONG_ITEM"
  | "NOT_AS_DESCRIBED"
  | "LATE_DELIVERY"
  | "CHANGED_MIND"
  | "NO_LONGER_NEEDED"
  | "OTHER";

export type RefundStatus = "PENDING" | "APPROVED" | "DENIED" | "ESCALATED";
export type OrderStatus = "PROCESSING" | "SHIPPED" | "DELIVERED" | "REFUNDED" | "CANCELLED";

export interface Customer {
  id: number;
  name: string;
  email: string;
}

export interface Order {
  id: number;
  orderNumber: string;
  productName: string;
  category: string;
  totalCents: number;
  isFinalSale: boolean;
  status: OrderStatus;
  orderedAt: string;
  deliveredAt: string | null;
  refundRequests: { id: number; status: RefundStatus; reason: RefundReason; requestedAt: string }[];
}

export interface CustomerOrders extends Customer {
  orders: Order[];
}

/** The fields of POST /refund-requests' response that the customer UI uses. */
export interface RefundResult {
  id: number;
  status: RefundStatus;
  reason: RefundReason;
  amountCents: number;
  customerMessage: string | null;
  /** Includes a final "reply" step saying whether the AI or the template wrote customerMessage. */
  reasoningLog?: ReasoningStep[] | null;
}

/** The AI's guess at the reason for free text; the customer confirms it before sending. */
export interface ReasonSuggestion {
  reason: RefundReason;
  label: string;
  summary: string;
  confidence: number;
}

/** One step of the stored decision trace (backend/src/services/refundService.ts). */
export type ReasoningStep =
  | { stage: "rerun"; at: string; evaluatedAsOf: string; previousStatus: RefundStatus; previousSource: string | null }
  | { stage: "policy_engine"; decision: "APPROVE" | "DENY" | "ESCALATE"; rule?: string; reasons: string[] }
  | { stage: "injection_scan"; detected: boolean; labels: string[] }
  | { stage: "ai"; consulted: false; skippedBecause: string }
  | {
      stage: "ai";
      consulted: true;
      /** anthropic | openai | gemini | openai-compatible | none. Absent on older traces. */
      provider?: string;
      model: string;
      /** assessment: rule-approved request; consistency_check: reason-dependent denial. Absent on older traces. */
      mode?: "assessment" | "consistency_check";
      outcome: "assessment" | "unavailable";
      recommendation?: "approved" | "denied" | "escalated";
      confidence?: number;
      reasoning?: string;
      flags?: string[];
      error?: string;
    }
  | { stage: "final"; decision: "approved" | "denied" | "escalated"; source: string; conflict: string | null }
  | { stage: "reply"; by: "ai" | "template"; provider?: string; model?: string; reason?: string };

export type DecisionSource = "policy_engine" | "injection_guard" | "ai_assisted" | "ai_unavailable";

/** Row of GET /refund-requests (admin dashboard). */
export interface RefundListItem {
  id: number;
  status: RefundStatus;
  reason: RefundReason;
  amountCents: number;
  requestedAt: string;
  resolvedAt: string | null;
  decisionSource: DecisionSource | null;
  injectionDetected: boolean;
  flags: string[] | null;
  customer: Customer;
  order: { id: number; orderNumber: string; productName: string; totalCents: number };
}

/** GET /refund-requests/:id */
export interface RefundDetail extends Omit<RefundListItem, "order"> {
  description: string | null;
  decisionNotes: string | null;
  customerMessage: string | null;
  reasoningLog: ReasoningStep[] | null;
  order: Omit<Order, "refundRequests">;
}

export interface SignInResult {
  token: string;
  expiresAt: string;
  customer: Customer;
}

/** The customer is taken from the session token; it is never sent in the body. */
export interface NewRefundRequest {
  orderId: number;
  message: string;
  reason: RefundReason;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Messages safe to show customers, keyed by the backend's error codes. */
function friendlyMessage(status: number, code: string, serverMessage?: string): string {
  // These server messages are written for customers.
  if ((code === "unauthorized" || code === "too_many_attempts") && serverMessage) return serverMessage;
  if (code === "conflict") return "You already have a refund request in progress for this order.";
  if (code === "not_found") return "We couldn't find that order on your account.";
  if (code === "validation_error" || code === "invalid_body") {
    return "Something in your request wasn't valid. Please check your message and try again.";
  }
  if (status >= 500) return "Something went wrong on our side. Please try again in a moment.";
  return "Your request couldn't be completed. Please try again.";
}

async function request<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 15_000, ...rest } = init;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = rest.signal ? AbortSignal.any([rest.signal, timeout]) : timeout;

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...rest,
      signal,
      headers: { "content-type": "application/json", ...rest.headers },
    });
  } catch (err) {
    if (rest.signal?.aborted) throw err; // caller cancelled; not an error to show
    if (timeout.aborted) {
      throw new ApiError(0, "timeout", "This is taking longer than expected. Please try again.");
    }
    throw new ApiError(0, "network", "We couldn't reach the support service. Check your connection and try again.");
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    const code = body?.error?.code ?? "unknown";
    throw new ApiError(res.status, code, friendlyMessage(res.status, code, body?.error?.message));
  }
  return (await res.json()) as T;
}

export interface Health {
  status: string;
  database: string;
  ai?: { provider: string; model: string | null; configured: boolean };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

export const api = {
  health: (signal?: AbortSignal) => request<Health>("/health", { signal }),

  // --- Customer (help center) ------------------------------------------------
  signIn: (email: string, orderNumber: string) =>
    request<SignInResult>("/auth/sign-in", { method: "POST", body: JSON.stringify({ email, orderNumber }) }),

  /** The signed-in customer's profile and orders. */
  me: (token: string, signal?: AbortSignal) => request<CustomerOrders>("/me", { signal, headers: auth(token) }),

  /** AI suggestion for free text; null when unsure/unavailable (the chat then shows the reason list). */
  suggestReason: (token: string, body: { orderId: number; message: string }) =>
    request<{ suggestion: ReasonSuggestion | null }>("/me/suggest-reason", {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify(body),
      timeoutMs: 60_000,
    }),

  /** May consult the AI model, so it gets a longer timeout than the lookups. */
  submitRefundRequest: (token: string, body: NewRefundRequest) =>
    request<RefundResult>("/refund-requests", {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify(body),
      timeoutMs: 120_000,
    }),

  // --- Staff (admin dashboard) -----------------------------------------------
  listRefundRequests: (signal?: AbortSignal) => request<RefundListItem[]>("/refund-requests", { signal }),

  getRefundRequest: (id: number, signal?: AbortSignal) => request<RefundDetail>(`/refund-requests/${id}`, { signal }),

  /** Staff action; may consult the AI model. */
  rerunRefundRequest: (id: number) =>
    request<RefundDetail>(`/refund-requests/${id}/rerun`, { method: "POST", timeoutMs: 120_000 }),
};
