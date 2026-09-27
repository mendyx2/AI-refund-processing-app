/**
 * Customer-facing explanation of a refund decision. Deliberately separate from
 * the internal trace: it never mentions injection detection, fraud signals, or
 * the AI's reasoning, which are for staff only.
 */
import type { FinalDecision } from "../aiLayer";
import {
  SELLER_FAULT_WINDOW_DAYS,
  daysSinceWindowStart,
  isSellerFault,
  refundWindowDays,
  type PolicyOrder,
  type PolicyRefundRequest,
  type PolicyRule,
} from "../policyEngine";

export interface CustomerMessageInput {
  decision: FinalDecision;
  rule: PolicyRule;
  order: Pick<PolicyOrder, "orderedAt" | "deliveredAt"> & { productName: string };
  request: PolicyRefundRequest;
  now: Date;
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function customerMessage({ decision, rule, order, request, now }: CustomerMessageInput): string {
  const item = order.productName;

  if (decision === "approved") {
    return (
      `Good news: your refund of ${money(request.amountCents)} for the ${item} has been approved. ` +
      "It will go back to your original payment method."
    );
  }

  if (decision === "escalated") {
    return (
      `Thanks for the details. We've passed your request for the ${item} to a member of our ` +
      "support team, who will review it and get back to you by email."
    );
  }

  switch (rule) {
    case "ALREADY_REFUNDED":
      return `This order has already been refunded, so we can't issue another refund for the ${item}.`;
    case "ORDER_CANCELLED":
      return "This order was cancelled before you were charged, so there's nothing to refund.";
    case "AMOUNT_EXCEEDS_TOTAL":
      return "The amount requested is more than the order total. Please check the amount and try again.";
    case "OUTSIDE_WINDOW": {
      const days = Math.floor(daysSinceWindowStart(order, now));
      const since = order.deliveredAt ? "delivered" : "placed";
      const base =
        `We're sorry, but this order is outside our ${refundWindowDays(request.reason)}-day refund ` +
        `window: it was ${since} ${days} days ago.`;
      // Buyer-side reason, but a seller-fault claim would still be in window.
      if (!isSellerFault(request.reason) && days <= SELLER_FAULT_WINDOW_DAYS) {
        return (
          `${base} If the item is defective, arrived damaged, or isn't what you ordered, ` +
          "choose that reason and we'll take another look."
        );
      }
      return base;
    }
    case "FINAL_SALE":
      return (
        `The ${item} was sold as final sale, so it can't be refunded for this reason. If it arrived ` +
        "defective, damaged, or isn't what you ordered, choose that reason and we'll review it."
      );
    default:
      // Not reachable via the policy engine: a denial always names its rule.
      return `We're unable to approve a refund for the ${item}.`;
  }
}
