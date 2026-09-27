import { describe, expect, it } from "vitest";

import { customerMessage, type CustomerMessageInput } from "./customerMessage";

const NOW = new Date("2026-09-27T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);

const input = (overrides: Partial<CustomerMessageInput> = {}): CustomerMessageInput => ({
  decision: "denied",
  rule: "OUTSIDE_WINDOW",
  order: { productName: "Desk Lamp", orderedAt: daysAgo(40), deliveredAt: daysAgo(35) },
  request: { reason: "CHANGED_MIND", amountCents: 45_50 },
  now: NOW,
  ...overrides,
});

describe("customerMessage", () => {
  it("confirms approvals with the amount and item", () => {
    expect(customerMessage(input({ decision: "approved", rule: "ELIGIBLE" }))).toBe(
      "Good news: your refund of $45.50 for the Desk Lamp has been approved. It will go back to your original payment method.",
    );
  });

  it("gives the same neutral message for every escalation, revealing no internal signal", () => {
    const messages = (["HUMAN_REVIEW", "ELIGIBLE"] as const).map((rule) =>
      customerMessage(input({ decision: "escalated", rule })),
    );
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toMatch(/member of our support team/);
    expect(messages[0]).not.toMatch(/injection|suspicious|fraud|\bAI\b|confidence/i);
  });

  it("explains the refund window and suggests a seller-fault reason when that would still apply", () => {
    const msg = customerMessage(input());
    expect(msg).toMatch(/outside our 30-day refund window: it was delivered 35 days ago/);
    expect(msg).toMatch(/If the item is defective/);
  });

  it("does not suggest another reason when the order is past every window", () => {
    const msg = customerMessage(
      input({ order: { productName: "Desk Lamp", orderedAt: daysAgo(80), deliveredAt: daysAgo(75) } }),
    );
    expect(msg).toMatch(/75 days ago\.$/);
  });

  it("does not suggest another reason when a seller-fault reason is already used", () => {
    const msg = customerMessage(
      input({
        request: { reason: "DEFECTIVE", amountCents: 1 },
        order: { productName: "Lamp", orderedAt: daysAgo(70), deliveredAt: daysAgo(65) },
      }),
    );
    expect(msg).toMatch(/60-day refund window/);
    expect(msg).not.toMatch(/choose that reason/);
  });

  it("measures from the order date when undelivered", () => {
    const msg = customerMessage(
      input({ order: { productName: "Lamp", orderedAt: daysAgo(33), deliveredAt: null } }),
    );
    expect(msg).toMatch(/it was placed 33 days ago/);
  });

  it.each([
    ["ALREADY_REFUNDED", /already been refunded/],
    ["ORDER_CANCELLED", /cancelled before you were charged/],
    ["AMOUNT_EXCEEDS_TOTAL", /more than the order total/],
    ["FINAL_SALE", /sold as final sale/],
  ] as const)("explains %s denials", (rule, pattern) => {
    expect(customerMessage(input({ rule }))).toMatch(pattern);
  });
});
