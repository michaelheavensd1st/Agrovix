# Agrovix AgOS — API (`apps/api`)

FastAPI backend for the Agrovix Agricultural Operating System.

## Local run

```bash
cd apps/api
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
cp .env.example .env

# start supporting infra
docker compose -f ../../docker-compose.yml up -d postgres redis

# apply migrations
alembic upgrade head

# start the API
uvicorn app.main:app --reload --port 8000
```

Open http://localhost:8000/docs for the interactive OpenAPI browser.

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
