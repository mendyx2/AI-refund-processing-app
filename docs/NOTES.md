# Notes for later documentation

Decisions and open questions to fold into the real docs. Newest first.

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
- **Failure handling:** API errors, refusals, truncation, a missing tool call,
  or tool input that fails validation all → **escalated**
  (`source: "ai_unavailable"`), logged. Non-API exceptions (bugs) are rethrown.
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
- Seed-data routing today: 4 of 14 pending requests reach Claude; the rest are
  settled by rules.

## Backend language (open decision)

- `/backend` currently holds **two runtimes**: FastAPI (Python) serves HTTP
  (`/health` only so far); Prisma + TypeScript own the schema, seed, policy
  engine and AI layer, sharing one SQLite file.
- The TS policy engine / AI layer cannot be called from Python. Choose one:
  (a) replace FastAPI with a TS server (Fastify/Express), or (b) keep FastAPI
  and port the engine to Python (or call TS as a service).

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
  recreate). This must change once the app writes real data.
