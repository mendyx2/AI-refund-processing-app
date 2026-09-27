# Refund Policy

This is the canonical refund policy. `src/policyEngine.ts` encodes these rules
as pure functions; if you change a number here, change it there too (and the
tests will tell you which ones moved).

## 1. Refund window

| Reason for refund | Window |
|---|---|
| Change of mind, no longer needed, not as described, late delivery, other | **30 days** |
| Seller fault: defective, damaged in transit, wrong item sent | **60 days** |

- The window is measured in calendar days from the **delivery date**. If the
  order has not been delivered yet, it is measured from the **order date**.
- The last day of the window counts (a request on day 30 is on time).
- **No refunds are issued for orders more than 60 days old**, for any reason.

## 2. Final-sale items

- Items marked **final sale** (clearance, gift cards, personalised items,
  opened hygiene products) are **not refundable** for change of mind or any
  other buyer-side reason.
- Exception: a final-sale item that arrived **defective, damaged in transit, or
  was the wrong item** may be refunded, but the claim must be verified by a
  person (see §4).

## 3. Orders that cannot be refunded

- Orders that have **already been refunded** cannot be refunded again.
- **Cancelled** orders were never charged and are not eligible.
- The refund amount cannot exceed the order total.

## 4. Human review

A request that is otherwise eligible must be **escalated to a human agent**
(never auto-approved) when any of the following is true:

1. The refund amount is **more than $500.00**.
2. The customer shows a **suspicious refund pattern** (§5).
3. It is a **final-sale** item being refunded under the seller-fault exception.

## 5. Suspicious refund patterns

A customer is flagged as suspicious when they have made **3 or more refund
requests within any 14-day period**, counting the request being evaluated.
Requests of every status (pending, approved, denied, escalated) count.

A flag is not a denial: it routes the request to human review.

### Conflicting requests

A request whose description **contradicts the selected reason or the order
record** is escalated to human review. For example, the customer picks
"changed my mind" but describes a broken item, or claims non-delivery for a
delivered order. This check is applied to every request the rules would
approve. It also applies to denials that depend only on the reason chosen: a
final-sale item, or an order 31–60 days old, under a buyer-side reason, where
a seller-fault reason would have changed the outcome. The check can only send
a request to a human. It never approves one.

## 6. Decision order

Requests are evaluated in this order; the first rule that applies decides.

1. Already refunded, cancelled, or amount exceeds order total → **deny**.
2. Outside the refund window (§1) → **deny**.
3. Final sale without a seller-fault reason (§2) → **deny**.
4. Any human-review trigger (§4) → **escalate**.
5. Conflicting request (§5) → **escalate**. This also applies to the
   reason-dependent denials in steps 2–3.
6. Otherwise → **approve**.
