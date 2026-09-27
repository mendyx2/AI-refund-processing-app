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
}

export interface NewRefundRequest {
  customerId: number;
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
function friendlyMessage(status: number, code: string): string {
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
    const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
    const code = body?.error?.code ?? "unknown";
    throw new ApiError(res.status, code, friendlyMessage(res.status, code));
  }
  return (await res.json()) as T;
}

export const api = {
  listCustomers: (signal?: AbortSignal) => request<Customer[]>("/customers", { signal }),

  customerOrders: (customerId: number, signal?: AbortSignal) =>
    request<CustomerOrders>(`/customers/${customerId}/orders`, { signal }),

  /** May consult Claude, so it gets a longer timeout than the lookups. */
  submitRefundRequest: (body: NewRefundRequest) =>
    request<RefundResult>("/refund-requests", {
      method: "POST",
      body: JSON.stringify(body),
      timeoutMs: 120_000,
    }),
};
