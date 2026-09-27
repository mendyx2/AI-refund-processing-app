# AI-refund-processing-app
AI-enabled customer support application that helps process, approve, deny, or escalate e-commerce refund requests based on customer order data and a defined refund policy.

## Project layout

```
frontend/          Next.js 14 (App Router, TypeScript, Tailwind)
  app/support/     Customer refund chat (/support)
  app/admin/       Admin dashboard (/admin)
  lib/api.ts       Typed client for the Express API
backend/           Express 5 + Prisma 7 (SQLite) + zod, TypeScript
  prisma/          schema.prisma (canonical data model), seed.ts, seedData.ts
  src/
    server.ts      Entry point; app.ts wires routes, CORS and error handling
    routes/        HTTP routes + zod validation
    services/      refundService.ts: the refund workflow and queries
    policyEngine.ts  Refund rules as pure functions
    aiLayer.ts     Claude judgment layer
  data/            refund_policy.md: the canonical refund policy
docs/NOTES.md      Design decisions and open questions
docker-compose.yml
```

## Running locally

From a clean checkout (needs Docker with Compose v2):

```bash
cp .env.example .env        # optional: add your ANTHROPIC_API_KEY
docker compose up --build   # or: docker-compose up --build
```

Then open http://localhost:3000/support (customer chat) or
http://localhost:3000/admin (staff dashboard). The API is on
http://localhost:8000.

Startup order:

| Service    | Port | Notes |
|------------|------|-------|
| `db-seed`  | —    | One-shot job: creates the SQLite schema on the `sqlite-data` volume and loads `prisma/seed.ts` **if the database is empty**, then exits. |
| `backend`  | 8000 | Express API. Starts after `db-seed` succeeds. Healthcheck: `GET /health`. |
| `frontend` | 3000 | Next.js. Starts once the backend is healthy. |

- **Data persists across restarts** in the `sqlite-data` volume. Start over
  with `docker compose down -v`. Do that after a schema change too, since
  `prisma db push` won't drop data on its own.
- **`ANTHROPIC_API_KEY` is optional.** Without it, requests that need
  Claude's judgment are escalated to a human instead of failing.

## Backend

```bash
cd backend
npm install          # also generates the Prisma client (src/generated/, git-ignored)
npm run db:setup     # create ./db/app.db from the schema; seed it if empty
npm run db:reset     # drop everything and reseed
npm run dev          # API on http://localhost:8000 (watch mode)
npm test             # Vitest: policy engine, AI layer, guardrails, seed scenarios, API routes
npm run typecheck
```

### API

| Method & path | Purpose |
|---|---|
| `POST /refund-requests` | Submit `{ customerId, orderId, message, reason?, amountCents? }`. Runs the policy engine, then the AI layer for judgment calls, and saves the decision with its reasoning trace, injection flags, and a plain-language `customerMessage`. Returns the saved request (201). `reason` defaults to `OTHER`; `amountCents` defaults to the order total. |
| `GET /refund-requests` | All requests, newest first (admin dashboard). Optional `?status=PENDING\|APPROVED\|DENIED\|ESCALATED`. |
| `GET /refund-requests/:id` | Full detail, including `reasoningLog`. |
| `POST /refund-requests/:id/rerun` | Staff action: re-runs an open (pending/escalated) request through the pipeline, judged as of its original date. `409` for approved/denied requests. |
| `GET /customers` | Customers by name (the support page's "sign in as" dropdown; no real auth yet). |
| `GET /customers/:id/orders` | A customer's orders, newest first, with their refund requests (chat UI order lookup). |
| `GET /health` | Liveness and database check. |

Errors always have the shape `{ "error": { "code", "message", "details?" } }`:
`400 validation_error / invalid_body`, `404 not_found`, `409 conflict` (the
order already has an open request), `500 internal_error`.

### Policy engine

`data/refund_policy.md` is the source of truth for the refund rules;
`src/policyEngine.ts` encodes it (`isFinalSale`, `isWithinRefundWindow`,
`requiresHumanReview`, `isSuspiciousPattern`, and `evaluateRefundRequest`,
which applies them in policy order). The seed data covers every decision
branch, and `prisma/seedData.test.ts` checks each seeded pending request
against its expected outcome.

### AI layer

`src/aiLayer.ts` consults Claude (`claude-opus-5`, via `@anthropic-ai/sdk`) only
for judgment calls the policy engine can't settle. Claude must answer through
the `submit_refund_assessment` tool. Its output is only a recommendation, and a
hard rule always wins. Customer text is wrapped in delimiters and treated as
untrusted, and likely prompt-injection attempts are escalated to a human. Set
`ANTHROPIC_API_KEY` to use it. The tests use a fake client. See
`docs/NOTES.md` for the full decision flow.

## Frontend

`/support` is the customer chat. Pick a seeded customer (no passwords), choose
an order and a reason, and describe the problem. The reply bubble shows the
decision (Approved / Not eligible / Under review) and the backend's
`customerMessage`. The browser calls the API at `NEXT_PUBLIC_API_URL`
(default `http://localhost:8000`). It is baked in at build time, so in Docker
it's a build arg in `docker-compose.yml`.

`/admin` lists every refund request (customer, order, decision, time) with
filter tabs by status and an "only injection / suspicion flags" toggle.
Expanding a row loads its detail: the customer's message, Claude's confidence,
all flags, what the customer was told, and the step-by-step reasoning trace.
Pending and escalated requests have a **Re-run decision** button.

```bash
cd frontend
npm install
npm run dev          # http://localhost:3000/support (needs the backend running)
```
