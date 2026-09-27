# AI-refund-processing-app
AI-enabled customer support application that helps process, approve, deny, or escalate e-commerce refund requests based on customer order data and a defined refund policy.

## Project layout

```
frontend/          Next.js 14 (App Router, TypeScript, Tailwind)
backend/           FastAPI + SQLAlchemy 2 + Pydantic v2
  app/             API code (main.py, db.py, models.py, schemas.py, seed.py)
  data/            Seed data (seed.json) and refund policy docs (policies/)
docker-compose.yml
```

## Running locally

```bash
docker compose up --build
```

Services:

| Service    | Port | Notes |
|------------|------|-------|
| `db-seed`  | —    | One-shot job: creates the schema and loads `backend/data/seed.json` into SQLite on the shared `sqlite-data` volume, then exits. |
| `backend`  | 8000 | Starts only after `db-seed` completes successfully. `GET /health` → `{"status":"ok","database":"ok"}` |
| `frontend` | 3000 | Starts once the backend healthcheck passes. Placeholder "Hello" page. |

The seed job re-runs (drop + recreate) on every `docker compose up`. Use `docker compose down -v` to also remove the volume.
