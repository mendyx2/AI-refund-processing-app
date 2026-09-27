# AI-refund-processing-app
AI-enabled customer support application that helps process, approve, deny, or escalate e-commerce refund requests based on customer order data and a defined refund policy.

## Project layout

```
frontend/          Next.js 14 (App Router, TypeScript, Tailwind)
backend/           FastAPI + SQLAlchemy 2 + Pydantic v2, plus Prisma (TypeScript)
  app/             FastAPI code (main.py, db.py, schemas.py)
  prisma/          schema.prisma (canonical data model), seed.ts, seedData.ts
  src/             policyEngine.ts: the refund policy as pure functions (+ tests)
  data/            refund_policy.md: the canonical refund policy
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
| `backend`  | 8000 | Starts only after `db-seed` completes successfully. `GET /health` → `{"status":"ok","database":"ok"}` |
| `frontend` | 3000 | Starts once the backend healthcheck passes. Placeholder "Hello" page. |

The seed job re-runs (drop + recreate) on every `docker compose up`. Use `docker compose down -v` to also remove the volume.

## Backend: Prisma and the policy engine

Prisma owns the database schema and seed data. The FastAPI service reads the
same SQLite file.

```bash
cd backend
npm install          # also generates the Prisma client (src/generated/, git-ignored)
npm run db:reset     # create ./db/app.db from the schema and seed it
npm test             # Vitest: policy engine + seed scenario tests
npm run typecheck
```

`data/refund_policy.md` is the source of truth for the refund rules;
`src/policyEngine.ts` encodes it (`isFinalSale`, `isWithinRefundWindow`,
`requiresHumanReview`, `isSuspiciousPattern`, and `evaluateRefundRequest`,
which applies them in policy order). The seed data covers every decision
branch, and `prisma/seedData.test.ts` checks each seeded pending request
against its expected outcome.
