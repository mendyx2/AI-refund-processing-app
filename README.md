# AI-refund-processing-app
AI-enabled customer support application that helps process, approve, deny, or escalate e-commerce refund requests based on customer order data and a defined refund policy.

## Project layout

```
frontend/          Next.js 14 (App Router, TypeScript, Tailwind)
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

```bash
docker compose up --build
```

Services:

| Service    | Port | Notes |
|------------|------|-------|
| `db-seed`  | —    | One-shot job: applies the Prisma schema to SQLite on the shared `sqlite-data` volume and runs `prisma/seed.ts`, then exits. |
| `backend`  | 8000 | Express API. Starts only after `db-seed` completes successfully. `GET /health` → `{"status":"ok","database":"ok"}` |
| `frontend` | 3000 | Starts once the backend healthcheck passes. Placeholder "Hello" page. |

The seed job re-runs (drop + recreate) on every `docker compose up`. Use `docker compose down -v` to also remove the volume.

To have Claude assess judgment-call requests, export `ANTHROPIC_API_KEY` before
`docker compose up`. Without it, those requests are escalated to a human.

## Backend

```bash
cd backend
npm install          # also generates the Prisma client (src/generated/, git-ignored)
npm run db:reset     # create ./db/app.db from the schema and seed it
npm run dev          # API on http://localhost:8000 (watch mode)
npm test             # Vitest: policy engine, AI layer, seed scenarios, API routes
npm run typecheck
```

### API

| Method & path | Purpose |
|---|---|
| `POST /refund-requests` | Submit `{ customerId, orderId, message, reason?, amountCents? }`. Runs the policy engine, then the AI layer for judgment calls, and saves the decision with its reasoning trace and injection flags. Returns the saved request (201). `reason` defaults to `OTHER`; `amountCents` defaults to the order total. |
| `GET /refund-requests` | All requests, newest first (admin dashboard). Optional `?status=PENDING\|APPROVED\|DENIED\|ESCALATED`. |
| `GET /refund-requests/:id` | Full detail, including `reasoningLog`. |
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
