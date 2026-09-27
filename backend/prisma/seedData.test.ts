import { describe, expect, it } from "vitest";

import { detectInjection, needsJudgment } from "../src/aiLayer";
import { evaluateRefundRequest } from "../src/policyEngine";
import { customers } from "./seedData";

const NOW = new Date("2026-09-27T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);
const cents = (amount: number) => Math.round(amount * 100);

// Every pending request in the seed data should land on its intended decision,
// so the seed keeps exercising each branch of the policy.
const cases = customers.flatMap((c) => {
  const history = c.orders.flatMap((o) =>
    (o.refunds ?? []).map((r) => ({ requestedAt: daysAgo(r.requestedDaysAgo) })),
  );
  return c.orders.flatMap((o) =>
    (o.refunds ?? [])
      .filter((r) => r.status === "PENDING")
      .map((r) => ({ customer: c.name, order: o, refund: r, history })),
  );
});

describe("seed scenarios", () => {
  it("has ~15 customers and a pending request for each decision", () => {
    expect(customers.length).toBe(15);
    const decisions = new Set(cases.map((c) => c.refund.expected));
    expect(decisions).toEqual(new Set(["APPROVE", "DENY", "ESCALATE"]));
  });

  it("covers the required order-history shapes", () => {
    const orders = customers.flatMap((c) => c.orders);
    expect(orders.some((o) => (o.deliveredDaysAgo ?? o.orderedDaysAgo) > 60)).toBe(true);
    expect(orders.some((o) => (o.deliveredDaysAgo ?? o.orderedDaysAgo) <= 7)).toBe(true);
    expect(orders.some((o) => o.finalSale)).toBe(true);
    expect(orders.some((o) => o.total > 500)).toBe(true);
    expect(orders.some((o) => o.status === "REFUNDED")).toBe(true);
  });

  it("includes a prompt-injection attempt and a vague judgment-call claim", () => {
    expect(cases.some((c) => detectInjection(c.refund.description).length > 0)).toBe(true);
    expect(
      cases.some(
        (c) => c.refund.reason === "NOT_AS_DESCRIBED" && detectInjection(c.refund.description).length === 0,
      ),
    ).toBe(true);
    expect(cases.filter((c) => needsJudgment(c.refund)).length).toBeGreaterThan(0);
  });

  it.each(cases)("$customer: $order.product → $refund.expected", ({ order, refund, history }) => {
    const totalCents = cents(order.total);
    const result = evaluateRefundRequest({
      order: {
        totalCents,
        isFinalSale: order.finalSale ?? false,
        status: order.status,
        orderedAt: daysAgo(order.orderedDaysAgo),
        deliveredAt: order.deliveredDaysAgo === undefined ? null : daysAgo(order.deliveredDaysAgo),
      },
      request: {
        reason: refund.reason,
        amountCents: refund.amount === undefined ? totalCents : cents(refund.amount),
      },
      customerRequests: history,
      now: NOW,
    });
    expect(refund.expected).toBeDefined();
    expect(result.decision).toBe(refund.expected);
  });
});
