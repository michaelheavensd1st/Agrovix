# PREVIEW SHIM WARNING

> ⚠️  **The `/app/backend/` (FastAPI + MongoDB) and `/app/frontend/` (CRA)
> directories are TEMPORARY Emergent-preview shims — they are NOT part
> of the production codebase.**

## Why they exist

The canonical Agrovix AgOS stack is defined in this monorepo:

| Layer   | Canonical path        | Stack                                     |
| ------- | --------------------- | ----------------------------------------- |
| Backend | `apps/api/`           | FastAPI · **PostgreSQL** · Redis · SQLAlchemy · Alembic |
| Web     | `apps/web/`           | Next.js 14 (App Router) · TypeScript · Tailwind |
| Mobile  | `apps/mobile/`        | Expo Router · React Native · SecureStore  |

The Emergent preview container that ships with this workspace, however,
runs a fixed supervisor stack (CRA + FastAPI + MongoDB). The two
directories below exist **only** so the live pod URL renders something
resembling the AgOS UI + API contract during Sprint reviews:

- `/app/backend/server.py` — a small FastAPI app with an in-memory
  store that mirrors the Sprint 0 endpoint surface. It intentionally
  keeps `motor`/MongoDB *only* to satisfy the pod's runtime baseline —
  no auth, tenancy, RBAC, or business data is ever persisted in Mongo.
- `/app/frontend/*` — a CRA + React Router shell that renders the same
  landing / login / register / dashboard / 404 pages as `apps/web/`.

## What you MUST NOT do with the shim

- **Do not import from it.** No file in `apps/` may reference `backend/`
  or `frontend/`.
- **Do not deploy it.** Only `apps/api`, `apps/web`, and `apps/mobile`
  are shipped to staging and production.
- **Do not treat it as canonical.** The API surface it exposes may lag
  behind the real backend during development — refer to `apps/api` for
  the source of truth.
- **Do not add business features to it.** Sprint 1+ business logic
  lives in `apps/api` (Postgres-backed) exclusively.

## Production code and MongoDB

**Production code does not depend on MongoDB.** The `motor` package is
only imported by `/app/backend/server.py` (the preview shim). A
verification script is provided:

```bash
scripts/verify-no-mongo.sh
```

which greps `apps/` and `packages/` for `motor` / `pymongo` /
`mongodb` imports and exits non-zero if any are found. This check
runs in CI (`.github/workflows/ci.yml → mongo-guard`).
