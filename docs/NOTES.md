# Notes for later documentation

Decisions and open questions to fold into the real docs. Newest first.

## Help center redesign + customer sign-in

- **Feedback:** the customer page looked plain. It listed every customer in a
  dropdown (a real privacy problem, and not how a support site works), and
  Send stayed disabled after picking a quick reply.
- **Sign-in = guest order lookup** (`POST /auth/sign-in`: email + order
  number):
  - issues an HMAC-signed token (`backend/src/auth.ts`, no dependency) with a
    2-hour TTL;
  - gives one generic 401 for any mismatch, so the form can't enumerate
    emails;
  - is rate-limited per IP (10 per 15 min, in memory).
- **Customer endpoints need the token:** `GET /me`, `POST /refund-requests`.
  The customer id comes from the token, and a `customerId` in the body is
  rejected, which closes the "API trusts the browser's customerId" gap.
  `GET /customers` and `GET /customers/:id/orders` are removed.
- **`AUTH_SECRET`** is optional; a random per-process secret means sessions
  end on restart.
- **Send fix:** a quick reply alone is enough to send; details are optional.
  The message defaults to the reason's label.
- **UI:**
  - `/` redirects to `/support` (config-level redirect; an in-page
    `redirect()` on a static page returned a 307 with no Location header);
  - branded sign-in with the policy at a glance, form first on phones;
  - order cards with category icons and refund state;
  - guided chat with quick-reply chips and decision cards;
  - staff dashboard with a header and clickable stat tiles that filter the
    table.
- Demo credentials live in the README, not in the UI.

## Any AI provider (`backend/src/ai/`)

- **Why:** reviewers may only have an OpenAI or Gemini key, and the app
  should not be tied to one vendor.
- **Two adapters behind `AssessmentProvider`** (`providers.ts`):
  - **Anthropic:** Messages API, strict tool, adaptive thinking, server-side
    refusal fallback.
  - **OpenAI-style** (Chat Completions function calling): OpenAI, Gemini (via
    Google's OpenAI-compatible endpoint), and any OpenAI-compatible API
    (Groq, Mistral, DeepSeek, OpenRouter, Together, Ollama, LM Studio).
  - On native OpenAI the function is forced and strict. Other compatible APIs
    get `tool_choice: "auto"` with no strict flag, because support varies; a
    missing call is caught as `ai_no_assessment`.
- **Adapters only transport.** They return raw tool input or an error code.
  Validation (`parseAssessment`), reconciliation and every guardrail stay in
  `aiLayer.ts`, so the policy-wins guarantee is provider-independent. The
  guardrail suite runs once per adapter to prove it.
- **Selection** (`config.ts`, pure and unit-tested):
  1. `AI_PROVIDER`, if set.
  2. Else the first of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
     `GEMINI_API_KEY`/`GOOGLE_API_KEY`.
  3. Else `AI_API_KEY`: with `AI_BASE_URL` it's OpenAI-compatible; otherwise
     the provider is inferred from the key's prefix.

  `AI_MODEL` and `AI_BASE_URL` override. Misconfiguration falls back to "no
  provider" with a logged reason rather than crashing the backend.
- **No key → `UnconfiguredProvider`:** requests get `ai_not_configured`
  (logged once at startup, not on every request). Behavior is the same as
  "AI unavailable".
- **The trace records `provider` and `model`** on the AI step. `/health` and
  the admin header show the active provider (never the key).
- **Compose passes all the variables** and adds `host.docker.internal` so a
  host-side Ollama is reachable on Linux too.
- **Unverified:** the OpenAI/Gemini default model names, and how well each
  provider follows the tool-call instruction. The tests use fake clients only.

## Conflicting requests (policy §5)

- **Why:** the brief says "suspicious or conflicting requests should be
  escalated". Before this change, a "changed my mind" request saying "it
  arrived broken" was auto-approved and never examined.
- **Claude now reviews every rule-approved request**, not only judgment-call
  reasons. It checks for conflicts between the description and the reason
  code or order record, and a conflict (`conflicting_request` flag) escalates
  the request.
- **Reason-dependent denials get a consistency check.** These are final-sale
  or 31–60-day denials under a buyer-side reason, where a seller-fault reason
  would have changed the outcome (`isReasonSensitiveDenial` in
  `policyEngine.ts`). Claude can only escalate them, never approve.
  - Denials that no reason could change (>60 days, already refunded,
    cancelled, over the total) never reach Claude.
  - Neither do reason-dependent denials whose text trips the injection scan:
    injection text cannot reopen a denial.
- **The invariant changed from "never more lenient than the engine"** to "no
  approval unless the rules allow it, no denial unless the rules require it".
  Claude's only power is to send a request to a human. The guardrail sweep
  (now 864 cases) asserts exactly that.
- **If Claude is unavailable:** clear-cut approvals (change of mind, late
  delivery, no longer needed) and denials keep the rules' decision; the
  consistency check is best-effort. Claims resting on the customer's account
  (defective, damaged, wrong item, not as described, other) are still
  escalated. This keeps the app usable without an API key.
- **Cost:** Claude is now called on most rule-approved requests, not only
  about a third of them.
- **The trace records the AI step's `mode`:** `assessment` or
  `consistency_check`.

## Re-run, guardrails, and Compose

- **Re-run decision** (`POST /refund-requests/:id/rerun`, button on `/admin`):
  - Only open requests (PENDING / ESCALATED); approved and denied are final (409).
  - The policy is evaluated **as of the original request time**, so a late
    re-run can't push a request outside its window.
  - Updates the same record, only if it is still open when saving, so two
    staff re-running at once can't both decide it.
  - Adds a leading `rerun` step to the trace (when, previous status and
    source). The earlier trace itself is replaced, not kept. Add a history
    table if full audit history is needed.
  - Uses: seeded pending requests; requests escalated while Claude was
    unavailable.
- **Injection-scan review fixes:** `.` in the regexes didn't match line
  breaks, so "ignore\nall previous\ninstructions" and "You  are\tnow"
  evaded the scan. So did Cyrillic look-alike letters ("іgnore"). The scanner
  now checks a whitespace-collapsed variant and folds common Cyrillic/Greek
  look-alikes. Still a lightweight net: paraphrases, other languages, and
  spaced-out letters can get past it. That's acceptable because Claude is
  never the final say (see guardrails).
- **Guardrail tests** (`backend/src/guardrails.test.ts`) run the real engine
  and AI layer against a fake Claude that always says "approve, 100%":
  injection variants escalate without calling Claude; a $600 request and a
  final-sale damage claim always go to a human; message text can't move a
  final-sale item into the damage exception. A sweep (648 cases then, 864 now) checks that the
  final decision is never more permissive than the policy engine's and that
  Claude alone never produces a denial.
- **Compose:** `db-seed` now runs `db:setup` (schema + seed only if empty)
  instead of a full reset, so restarts keep data. Reset with
  `docker compose down -v`. The frontend has a healthcheck, and both
  long-running services restart `unless-stopped`. `.env.example` documents
  `ANTHROPIC_API_KEY`.

## Admin dashboard (`frontend/app/admin`)

- **No auth.** `/admin` and the `GET /refund-requests*` endpoints are open.
  Put them behind staff auth before any real use.
- **Loads the whole list once and filters client-side,** so the tabs can show
  counts. Fine at demo scale; add server-side pagination and filtering
  (the API already accepts `?status=`) when volume grows.
- **Details load on expand** (`GET /refund-requests/:id`) and are cached until
  Refresh.
- **`suspicious_pattern` is a structured flag.** The AI layer records it
  whenever the customer's history matches policy §5, next to the
  `injection:*` labels. Previously it existed only as prose in the policy
  reasons. The "only injection / suspicion flags" toggle filters on these two
  kinds.
- **Seeded requests have no trace.** They were inserted by the seed, not
  processed, so they show as "Awaiting decision" (pending) or
  "Historical record". Seeded pending requests are never processed
  automatically; a "re-run decision" action would be a natural next step.

## Customer support page (`frontend/app/support`)

- ~~**"Login" is a dropdown** fed by `GET /customers`.~~ Replaced by email +
  order-number sign-in (see "Help center redesign + customer sign-in").
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
- ~~The seed job wiped the database on every `up`/restart.~~ Fixed: it now
  seeds only an empty database (see "Re-run, guardrails, and Compose").
