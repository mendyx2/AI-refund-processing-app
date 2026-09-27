/**
 * Pure encoding of data/refund_policy.md. No I/O and no clock reads: every
 * time-dependent function takes `now` explicitly so it can be tested.
 */

export const STANDARD_WINDOW_DAYS = 30;
export const SELLER_FAULT_WINDOW_DAYS = 60;
export const HUMAN_REVIEW_THRESHOLD_CENTS = 500_00;
export const SUSPICIOUS_REQUEST_COUNT = 3;
export const SUSPICIOUS_WINDOW_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type RefundReason =
  | "DEFECTIVE"
  | "DAMAGED_IN_TRANSIT"
  | "WRONG_ITEM"
  | "NOT_AS_DESCRIBED"
  | "LATE_DELIVERY"
  | "CHANGED_MIND"
  | "NO_LONGER_NEEDED"
  | "OTHER";

export type OrderStatus =
  | "PROCESSING"
  | "SHIPPED"
  | "DELIVERED"
  | "REFUNDED"
  | "CANCELLED";

/** Structural subsets of the Prisma models, so callers can pass rows directly. */
export interface PolicyOrder {
  totalCents: number;
  isFinalSale: boolean;
  status: OrderStatus;
  orderedAt: Date;
  deliveredAt: Date | null;
}

export interface PolicyRefundRequest {
  reason: RefundReason;
  amountCents: number;
}

export interface TimestampedRequest {
  requestedAt: Date;
}

export type Decision = "APPROVE" | "DENY" | "ESCALATE";

/** Which rule decided (§6 order), so callers can explain it without parsing reasons. */
export type PolicyRule =
  | "ALREADY_REFUNDED"
  | "ORDER_CANCELLED"
  | "AMOUNT_EXCEEDS_TOTAL"
  | "OUTSIDE_WINDOW"
  | "FINAL_SALE"
  | "HUMAN_REVIEW"
  | "ELIGIBLE";

export interface PolicyEvaluation {
  decision: Decision;
  rule: PolicyRule;
  reasons: string[];
}

const SELLER_FAULT_REASONS: ReadonlySet<RefundReason> = new Set([
  "DEFECTIVE",
  "DAMAGED_IN_TRANSIT",
  "WRONG_ITEM",
]);

export function isSellerFault(reason: RefundReason): boolean {
  return SELLER_FAULT_REASONS.has(reason);
}

/** §2: the item was sold as final sale. */
export function isFinalSale(order: Pick<PolicyOrder, "isFinalSale">): boolean {
  return order.isFinalSale;
}

/** §1: window is measured from delivery, or from the order date if undelivered. */
export function refundWindowDays(reason: RefundReason): number {
  return isSellerFault(reason) ? SELLER_FAULT_WINDOW_DAYS : STANDARD_WINDOW_DAYS;
}

export function daysSinceWindowStart(
  order: Pick<PolicyOrder, "orderedAt" | "deliveredAt">,
  now: Date,
): number {
  const start = order.deliveredAt ?? order.orderedAt;
  return (now.getTime() - start.getTime()) / MS_PER_DAY;
}

/** §1: true when `now` is on or before the last day of the applicable window. */
export function isWithinRefundWindow(
  order: Pick<PolicyOrder, "orderedAt" | "deliveredAt">,
  reason: RefundReason,
  now: Date,
): boolean {
  return daysSinceWindowStart(order, now) <= refundWindowDays(reason);
}

/**
 * §5: `requests` is the customer's full request history, including the one
 * being evaluated. True if any rolling window holds the threshold count.
 */
export function isSuspiciousPattern(requests: readonly TimestampedRequest[]): boolean {
  if (requests.length < SUSPICIOUS_REQUEST_COUNT) return false;
  const times = requests.map((r) => r.requestedAt.getTime()).sort((a, b) => a - b);
  const windowMs = SUSPICIOUS_WINDOW_DAYS * MS_PER_DAY;
  for (let i = 0; i + SUSPICIOUS_REQUEST_COUNT - 1 < times.length; i++) {
    if (times[i + SUSPICIOUS_REQUEST_COUNT - 1] - times[i] <= windowMs) return true;
  }
  return false;
}

/** §4: returns the human-review triggers that apply (empty = none). */
export function humanReviewReasons(
  order: Pick<PolicyOrder, "isFinalSale">,
  request: PolicyRefundRequest,
  customerRequests: readonly TimestampedRequest[],
): string[] {
  const reasons: string[] = [];
  if (request.amountCents > HUMAN_REVIEW_THRESHOLD_CENTS) {
    reasons.push("Refund amount exceeds $500.00");
  }
  if (isSuspiciousPattern(customerRequests)) {
    reasons.push(
      `Customer made ${SUSPICIOUS_REQUEST_COUNT}+ refund requests within ${SUSPICIOUS_WINDOW_DAYS} days`,
    );
  }
  if (isFinalSale(order) && isSellerFault(request.reason)) {
    reasons.push("Final-sale item claimed under seller-fault exception; verify claim");
  }
  return reasons;
}

/** §4 */
export function requiresHumanReview(
  order: Pick<PolicyOrder, "isFinalSale">,
  request: PolicyRefundRequest,
  customerRequests: readonly TimestampedRequest[],
): boolean {
  return humanReviewReasons(order, request, customerRequests).length > 0;
}

/** §6: applies the rules in policy order; the first match decides. */
export function evaluateRefundRequest(input: {
  order: PolicyOrder;
  request: PolicyRefundRequest;
  customerRequests: readonly TimestampedRequest[];
  now: Date;
}): PolicyEvaluation {
  const { order, request, customerRequests, now } = input;

  if (order.status === "REFUNDED") {
    return { decision: "DENY", rule: "ALREADY_REFUNDED", reasons: ["Order has already been refunded"] };
  }
  if (order.status === "CANCELLED") {
    return { decision: "DENY", rule: "ORDER_CANCELLED", reasons: ["Order was cancelled and never charged"] };
  }
  if (request.amountCents > order.totalCents) {
    return { decision: "DENY", rule: "AMOUNT_EXCEEDS_TOTAL", reasons: ["Refund amount exceeds order total"] };
  }
  if (!isWithinRefundWindow(order, request.reason, now)) {
    const days = Math.floor(daysSinceWindowStart(order, now));
    return {
      decision: "DENY",
      rule: "OUTSIDE_WINDOW",
      reasons: [`Outside the ${refundWindowDays(request.reason)}-day refund window (${days} days)`],
    };
  }
  if (isFinalSale(order) && !isSellerFault(request.reason)) {
    return { decision: "DENY", rule: "FINAL_SALE", reasons: ["Final-sale items are not refundable for this reason"] };
  }

  const review = humanReviewReasons(order, request, customerRequests);
  if (review.length > 0) return { decision: "ESCALATE", rule: "HUMAN_REVIEW", reasons: review };

  return { decision: "APPROVE", rule: "ELIGIBLE", reasons: ["Meets all refund policy criteria"] };
}
