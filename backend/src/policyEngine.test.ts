import { describe, expect, it } from "vitest";

import {
  evaluateRefundRequest,
  isFinalSale,
  isReasonSensitiveDenial,
  isSuspiciousPattern,
  isWithinRefundWindow,
  requiresHumanReview,
  type PolicyOrder,
  type PolicyRefundRequest,
} from "./policyEngine";

const NOW = new Date("2026-09-27T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);
const requestsAt = (...days: number[]) => days.map((d) => ({ requestedAt: daysAgo(d) }));

const order = (overrides: Partial<PolicyOrder> = {}): PolicyOrder => ({
  totalCents: 100_00,
  isFinalSale: false,
  status: "DELIVERED",
  orderedAt: daysAgo(15),
  deliveredAt: daysAgo(10),
  ...overrides,
});

const request = (overrides: Partial<PolicyRefundRequest> = {}): PolicyRefundRequest => ({
  reason: "CHANGED_MIND",
  amountCents: 100_00,
  ...overrides,
});

describe("isFinalSale", () => {
  it("reflects the order's final-sale flag", () => {
    expect(isFinalSale(order({ isFinalSale: true }))).toBe(true);
    expect(isFinalSale(order({ isFinalSale: false }))).toBe(false);
  });
});

describe("isWithinRefundWindow", () => {
  it("allows change-of-mind requests within 30 days of delivery", () => {
    expect(isWithinRefundWindow(order({ deliveredAt: daysAgo(29) }), "CHANGED_MIND", NOW)).toBe(true);
  });

  it("includes the last day of the window", () => {
    expect(isWithinRefundWindow(order({ deliveredAt: daysAgo(30) }), "CHANGED_MIND", NOW)).toBe(true);
  });

  it("rejects change-of-mind requests after 30 days", () => {
    expect(isWithinRefundWindow(order({ deliveredAt: daysAgo(31) }), "CHANGED_MIND", NOW)).toBe(false);
  });

  it("extends the window to 60 days for seller-fault reasons", () => {
    const o = order({ deliveredAt: daysAgo(45) });
    expect(isWithinRefundWindow(o, "DEFECTIVE", NOW)).toBe(true);
    expect(isWithinRefundWindow(o, "DAMAGED_IN_TRANSIT", NOW)).toBe(true);
    expect(isWithinRefundWindow(o, "WRONG_ITEM", NOW)).toBe(true);
    expect(isWithinRefundWindow(o, "NOT_AS_DESCRIBED", NOW)).toBe(false);
  });

  it("never allows refunds past 60 days, even for seller fault", () => {
    expect(isWithinRefundWindow(order({ deliveredAt: daysAgo(61) }), "DEFECTIVE", NOW)).toBe(false);
  });

  it("measures from the order date when the order has not been delivered", () => {
    const undelivered = order({ status: "SHIPPED", deliveredAt: null, orderedAt: daysAgo(31) });
    expect(isWithinRefundWindow(undelivered, "LATE_DELIVERY", NOW)).toBe(false);
    expect(isWithinRefundWindow({ ...undelivered, orderedAt: daysAgo(8) }, "LATE_DELIVERY", NOW)).toBe(true);
  });

  it("measures from delivery, not order date, when delivered", () => {
    const o = order({ orderedAt: daysAgo(40), deliveredAt: daysAgo(20) });
    expect(isWithinRefundWindow(o, "CHANGED_MIND", NOW)).toBe(true);
  });
});

describe("isSuspiciousPattern", () => {
  it("is false with fewer than 3 requests", () => {
    expect(isSuspiciousPattern([])).toBe(false);
    expect(isSuspiciousPattern(requestsAt(1, 2))).toBe(false);
  });

  it("flags 3 requests within 14 days", () => {
    expect(isSuspiciousPattern(requestsAt(1, 5, 10))).toBe(true);
  });

  it("flags exactly 14 days apart (inclusive)", () => {
    expect(isSuspiciousPattern(requestsAt(0, 7, 14))).toBe(true);
  });

  it("does not flag 3 requests spread over more than 14 days", () => {
    expect(isSuspiciousPattern(requestsAt(0, 10, 15))).toBe(false);
  });

  it("finds a dense window anywhere in a long history, regardless of input order", () => {
    expect(isSuspiciousPattern(requestsAt(200, 3, 150, 100, 60, 61, 62))).toBe(true);
  });

  it("does not flag a regular customer with spaced-out requests", () => {
    expect(isSuspiciousPattern(requestsAt(0, 30, 90, 180, 300))).toBe(false);
  });
});

describe("requiresHumanReview", () => {
  it("is false for an ordinary request", () => {
    expect(requiresHumanReview(order(), request(), requestsAt(0))).toBe(false);
  });

  it("requires review above $500", () => {
    expect(requiresHumanReview(order(), request({ amountCents: 500_01 }), requestsAt(0))).toBe(true);
  });

  it("does not require review at exactly $500", () => {
    expect(requiresHumanReview(order(), request({ amountCents: 500_00 }), requestsAt(0))).toBe(false);
  });

  it("requires review for a suspicious customer", () => {
    expect(requiresHumanReview(order(), request(), requestsAt(0, 3, 6))).toBe(true);
  });

  it("requires review for a final-sale seller-fault claim", () => {
    const o = order({ isFinalSale: true });
    expect(requiresHumanReview(o, request({ reason: "DEFECTIVE" }), requestsAt(0))).toBe(true);
  });
});

describe("evaluateRefundRequest", () => {
  const evaluate = (
    o: Partial<PolicyOrder> = {},
    r: Partial<PolicyRefundRequest> = {},
    history = requestsAt(0),
  ) =>
    evaluateRefundRequest({ order: order(o), request: request(r), customerRequests: history, now: NOW });

  it("approves an ordinary in-window request", () => {
    expect(evaluate()).toMatchObject({ decision: "APPROVE", rule: "ELIGIBLE" });
  });

  it.each([
    ["ALREADY_REFUNDED", { status: "REFUNDED" }, {}],
    ["ORDER_CANCELLED", { status: "CANCELLED" }, {}],
    ["AMOUNT_EXCEEDS_TOTAL", { totalCents: 10_00 }, { amountCents: 20_00 }],
    ["OUTSIDE_WINDOW", { deliveredAt: daysAgo(45) }, {}],
    ["FINAL_SALE", { isFinalSale: true }, {}],
    ["HUMAN_REVIEW", { totalCents: 900_00 }, { amountCents: 900_00 }],
  ] as const)("reports the deciding rule %s", (rule, o, r) => {
    expect(evaluate(o as Partial<PolicyOrder>, r as Partial<PolicyRefundRequest>).rule).toBe(rule);
  });

  it("denies an already-refunded order", () => {
    expect(evaluate({ status: "REFUNDED" }).decision).toBe("DENY");
  });

  it("denies a cancelled order", () => {
    expect(evaluate({ status: "CANCELLED" }).decision).toBe("DENY");
  });

  it("denies a refund larger than the order total", () => {
    expect(evaluate({ totalCents: 50_00 }, { amountCents: 60_00 }).decision).toBe("DENY");
  });

  it("denies orders older than 60 days", () => {
    const result = evaluate({ deliveredAt: daysAgo(75) }, { reason: "DEFECTIVE" });
    expect(result.decision).toBe("DENY");
    expect(result.reasons[0]).toMatch(/60-day/);
  });

  it("denies final-sale change-of-mind requests", () => {
    expect(evaluate({ isFinalSale: true }).decision).toBe("DENY");
  });

  it("escalates final-sale defect claims", () => {
    expect(evaluate({ isFinalSale: true }, { reason: "DEFECTIVE" }).decision).toBe("ESCALATE");
  });

  it("escalates high-value requests", () => {
    const result = evaluate({ totalCents: 1299_00 }, { amountCents: 1299_00, reason: "DEFECTIVE" });
    expect(result.decision).toBe("ESCALATE");
    expect(result.reasons).toContain("Refund amount exceeds $500.00");
  });

  it("escalates suspicious customers instead of approving", () => {
    expect(evaluate({}, {}, requestsAt(0, 4, 9, 12)).decision).toBe("ESCALATE");
  });

  it("denies before escalating: an out-of-window high-value request is denied", () => {
    const result = evaluate({ deliveredAt: daysAgo(90), totalCents: 900_00 }, { amountCents: 900_00 });
    expect(result.decision).toBe("DENY");
  });

  it("lists every human-review trigger that applies", () => {
    const result = evaluate(
      { isFinalSale: true, totalCents: 800_00 },
      { amountCents: 800_00, reason: "WRONG_ITEM" },
      requestsAt(0, 2, 4),
    );
    expect(result.decision).toBe("ESCALATE");
    expect(result.reasons).toHaveLength(3);
  });
});

describe("isReasonSensitiveDenial", () => {
  const sensitive = (o: Partial<PolicyOrder>, r: Partial<PolicyRefundRequest> = {}) => {
    const ord = order(o);
    const req = request(r);
    const evaluation = evaluateRefundRequest({ order: ord, request: req, customerRequests: [], now: NOW });
    return isReasonSensitiveDenial(evaluation, ord, req, NOW);
  };

  it("is true for a final-sale denial under a buyer-side reason", () => {
    expect(sensitive({ isFinalSale: true })).toBe(true);
  });

  it("is true for a 31-60 day window denial under a buyer-side reason", () => {
    expect(sensitive({ deliveredAt: daysAgo(31) })).toBe(true);
    expect(sensitive({ deliveredAt: daysAgo(60) })).toBe(true);
  });

  it("is false once no reason code could change the outcome", () => {
    expect(sensitive({ deliveredAt: daysAgo(61) })).toBe(false);
    expect(sensitive({ status: "REFUNDED" })).toBe(false);
    expect(sensitive({ status: "CANCELLED" })).toBe(false);
    expect(sensitive({ totalCents: 10_00 }, { amountCents: 20_00 })).toBe(false);
  });

  it("is false when a seller-fault reason was already chosen", () => {
    expect(sensitive({ deliveredAt: daysAgo(61) }, { reason: "DEFECTIVE" })).toBe(false);
  });
});
