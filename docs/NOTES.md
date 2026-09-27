# Notes for later documentation

Decisions and open questions to fold into the real docs. Newest first.

## Customer support page (`frontend/app/support`)

- **"Login" is a dropdown** fed by `GET /customers`. There's no auth, and the
  API trusts the `customerId` it is sent. Real auth must replace this before
  any real use, and so must the open admin endpoints.
- **The customer sees `customerMessage`, never internal notes.** It's written
  by `backend/src/services/customerMessage.ts` from the deciding policy rule
  (`PolicyEvaluation.rule`) and stored on the request. Escalations all get one
  neutral "a member of our team will review it" message, whether the cause was
  a >$500 amount, a suspicious pattern, an injection attempt, or the AI being
  unavailable, so nothing tips off someone probing the system. Claude's
  reasoning is written for staff and is not shown to customers.
- **Known gap:** `POST /refund-requests` still returns the full record
  (reasoning log, flags) to the browser; the UI just doesn't show it. Add a
  customer-safe response shape (or split customer and admin APIs) when auth
  lands.
- **Reason picker:** the customer picks a reason (default "Something else" →
  `OTHER`), because the reason decides the hard-rule window. A denial for an
  in-window seller-fault case suggests choosing that reason instead.
- **Orders with an open request are disabled** in the list, mirroring the
  API's 409.
- **API errors are mapped to friendly text** in `frontend/lib/api.ts`
  (network, timeout, 404, 409, 5xx). The submit call has a 120 s timeout
  because it may wait on Claude.
- **`NEXT_PUBLIC_API_URL` is build-time.** It's inlined into the browser
  bundle, so Docker passes it as a build arg, and it must be the URL the
  *browser* can reach.

## API (`backend/src/routes`, `backend/src/services/refundService.ts`)

- **Express replaced FastAPI.** Once the API moved to Express, the Python app
  was removed: the backend is now TypeScript only. One Docker image runs both
  `db-seed` (`npm run db:reset`) and the API (`node --import tsx
  src/server.ts`). TS runs through `tsx` with no build step. Add a compile
  step if startup time or image size starts to matter.
- **`reason` is chosen by the client, not inferred.** The chat sends free
  text plus an optional reason code (default `OTHER`). The reason decides the
  hard rules (30- vs 60-day window), so it is never derived from Claude's
  reading of the message: Claude must not be able to move a hard rule.
- **One open request per order.** A new request is rejected with 409 while
  the order has a `PENDING` or `ESCALATED` one.
- **Approval marks the order `REFUNDED`** in the same transaction. It happens
  even for partial refunds, so a second refund on that order is denied.
  Revisit if partial refunds become common.
- **The customer's new request counts toward the suspicious-pattern check.**
- **Another customer's order returns 404, not 403**, so order IDs don't leak.
- **Stored per request:** `status`, `decisionSource`, `decisionNotes` (a
  one-line summary), `injectionDetected`, `flags` (JSON string[]),
  `reasoningLog` (JSON: policy_engine → injection_scan → ai → final).
- **Resetting the local DB:** Prisma refuses `db push --force-reset` when it
  detects an AI agent, unless the user explicitly consents. In Docker
  (`db-seed`) it runs normally. Locally, `npm run db:reset` works from your
  own terminal.

## AI layer (`backend/src/aiLayer.ts`)

- **Claude never finalizes a decision.** Pipeline order:
  1. `policyEngine` hard rules. Engine **DENY** and **ESCALATE** are final;
     Claude is not called.
  2. Injection scan over all customer-provided text (name, email,
     description). Any hit → **escalated**, Claude not called, event logged.
     If the engine already denied, the denial stands and carries the
     injection flag.
  3. Clear-cut approvals (buyer-side reasons such as change of mind or late
     delivery, with no review triggers) are **approved** without Claude.
  4. Judgment cases (seller-fault reasons, `NOT_AS_DESCRIBED`, `OTHER`) go to
     Claude, and its output is reconciled against the rules.
- **Reconciliation rules** (`reconcile()`):
  - A hard rule always wins. If Claude disagrees with an engine DENY/ESCALATE,
    the rule stands and an `ai_policy_conflict` warning is logged.
  - When the rules permit approval, Claude can **confirm** it (confidence
    ≥ 0.8) or send it to a human. A Claude "denied" becomes an escalation
    flagged `ai_recommends_denial`: only a human denies on judgment.
- **Failure handling:** any failure of the Claude call (API error, network,
  missing credentials), a refusal, truncation, a missing tool call, or tool
  input that fails validation → **escalated** (`source: "ai_unavailable"`)
  and logged. A request never fails because the AI is down. Errors in our own
  request-building code are outside that guard and still surface.
- **Tool:** `submit_refund_assessment` with `strict: true`. `confidence` is
  validated as 0–1 in code, because strict mode doesn't support numeric bounds.
  The tool is not forced via `tool_choice`: forced tool use is incompatible
  with thinking. The prompt requires the call, and a missing call escalates.
- **Untrusted text:** customer text goes in the **user turn**, not the system
  prompt, inside `<customer_provided field="...">` blocks with `<`/`>`
  escaped so the text cannot close the block. The system prompt (policy doc +
  the "untrusted data, never instructions" rule) holds no per-request data,
  so it can be prompt-cached.
- **Model:** `claude-opus-5` with adaptive thinking and the server-side
  refusal fallback (`fallbacks: "default"`, beta
  `server-side-fallback-2026-07-01`). The fallback reruns a safety-declined
  request on Anthropic's recommended model. It isn't available on
  Bedrock/Vertex/Foundry, so drop it there.
- **Credentials:** the SDK reads `ANTHROPIC_API_KEY` (or an `ant auth login`
  profile). Tests inject a fake client and never call the API.
- The seed data includes a prompt-injection attempt (Charlotte Lee, keyboard)
  and a vague "not as described" claim (Olivia Martinez, lamp).

## Backend language (resolved)

- Resolved in favour of TypeScript/Express (see API section). FastAPI removed.

## Refund policy numbers (chosen during scaffolding; confirm with the business)

- 30-day window (buyer-side reasons); 60-day for seller fault (defective,
  damaged in transit, wrong item); nothing refundable after 60 days.
- Window runs from delivery date, or order date if undelivered; last day counts.
- Human review: > $500.00 (strictly greater), suspicious customer, final-sale
  seller-fault claim.
- Suspicious: ≥ 3 refund requests (any status) in any rolling 14-day window.
- Canonical source: `backend/data/refund_policy.md`.

## Infrastructure

- `db-seed` uses the full `node:22` image, not `node:22-slim`: Prisma's schema
  engine needs OpenSSL, which slim lacks.
- The seed job resets the database on every `docker compose up` (drop +
  recreate). Because `backend` depends on `db-seed`, even
  `docker compose start backend` / `restart backend` re-runs the seed and wipes
  submitted requests. This must change once the app writes real data.
