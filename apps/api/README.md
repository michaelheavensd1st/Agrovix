# Agrovix AgOS — API (`apps/api`)

FastAPI backend for the Agrovix Agricultural Operating System.

## Compose-managed local run

```bash
scripts/dev/check.sh
scripts/dev/start.sh
scripts/dev/migrate.sh   # explicit; only needed when status reports pending
scripts/dev/status.sh
```

Run these commands from the repository root. Docker Compose supervises PostgreSQL, Redis,
FastAPI, and Next.js. The browser reaches the API through
`http://localhost:3000/api-proxy`; direct <http://localhost:8000/docs> access is retained on
host loopback for diagnostics only. PostgreSQL and Redis have no host-published ports.

Migrations never run during API startup. `scripts/dev/migrate.sh` shows current and target
revisions, requires confirmation, runs Alembic inside the API container, and verifies the result.

## Developer/UAT bootstrap

After migrations, a non-production database can be populated with the minimum persistent
tenant hierarchy needed for browser UAT. The command is idempotent, creates only missing
records, and refuses to run when `APP_ENV` is `production` or `prod`.

From the repository root, run `scripts/dev/bootstrap-uat.sh`. It forwards an existing
`AGROVIX_UAT_PASSWORD` without printing it or prompts securely when it is absent. Optional
`AGROVIX_UAT_EMAIL`, `AGROVIX_UAT_ORG_NAME`, and `AGROVIX_UAT_FARM_NAME` values are forwarded
when set. The bootstrap is never invoked by startup or migration commands.

`AGROVIX_UAT_PASSWORD` may be omitted only in an interactive terminal, where the command
uses a hidden password prompt. No password, hash, token, or secret is printed. Existing
matching records are preserved; inactive, deleted, or structurally conflicting records cause
the command to refuse rather than repair or overwrite them.

Runtime inspection and recovery:

```bash
scripts/dev/logs.sh api
scripts/dev/status.sh
scripts/dev/stop.sh       # preserves data; safe to repeat
scripts/dev/start.sh      # recovers the same Compose services
```

`scripts/dev/reset.sh` is the only destructive runtime command and deletes the named PostgreSQL
and Redis volumes after explicit confirmation. Compose project and volume names are derived from
the checkout path, isolating data when multiple checkouts are used concurrently.

## Layout

```
app/
├── main.py          # app factory + baseline routes (/, /health, /version)
├── core/            # config, security (JWT + bcrypt), logging
├── db/              # SQLAlchemy async engine + base + mixins
├── models/          # ORM models (User, Role, Permission, RefreshToken)
├── schemas/         # Pydantic v2 request/response schemas
├── repositories/    # Data-access layer
├── services/        # Business orchestration (AuthService)
├── api/v1/          # Versioned HTTP routers
└── deps.py          # FastAPI dependency-injection helpers
```

## Endpoints (Sprint 0)

- `GET  /` — service banner
- `GET  /health` — shallow liveness
- `GET  /version` — service version info
- `GET  /api/v1/health/` — v1 liveness
- `GET  /api/v1/health/ready` — DB + Redis readiness
- `GET  /api/v1/version/` — detailed version metadata
- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `GET  /api/v1/auth/me` — protected

## Migrations (Alembic)

```bash
alembic upgrade head                       # apply
alembic revision --autogenerate -m "…"     # create
alembic downgrade -1                        # rollback last
```

## Quality gates

```bash
ruff check .
black --check .
pytest -v --cov=app
```
