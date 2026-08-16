# Agrovix AgOS

**Agrovix AgOS** is an enterprise-grade **Agricultural Operating System** built as a Turborepo
monorepo. This repository contains the Sprint 0 foundation — the shared architecture, tooling,
authentication scaffold, and infrastructure primitives that all future farm-domain features
will be built on top of.

> **Status:** Sprint 0 · foundation only. Farm business logic is intentionally out of scope for
> this milestone.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Repository Layout](#repository-layout)
3. [Technology Stack](#technology-stack)
4. [Prerequisites](#prerequisites)
5. [Quick Start (Local Development)](#quick-start-local-development)
6. [Environment Variables](#environment-variables)
7. [Running with Docker Compose](#running-with-docker-compose)
8. [Common Commands](#common-commands)
9. [Backend (FastAPI) Details](#backend-fastapi-details)
10. [Web (Next.js) Details](#web-nextjs-details)
11. [Mobile (Expo / React Native) Details](#mobile-expo--react-native-details)
12. [Shared Packages](#shared-packages)
13. [Continuous Integration](#continuous-integration)
14. [Coding Standards](#coding-standards)
15. [License](#license)

---

## Architecture Overview

AgOS follows a **clean, layered architecture** built for portability and extensibility:

```
┌────────────────────────┐   ┌────────────────────────┐   ┌────────────────────────┐
│   apps/web (Next.js)   │   │  apps/mobile (Expo)    │   │  Future clients …      │
└──────────┬─────────────┘   └──────────┬─────────────┘   └──────────┬─────────────┘
           │                            │                            │
           ▼                            ▼                            ▼
        ┌──────────────────────────────────────────────────────────────┐
        │                    apps/api (FastAPI)                        │
        │  ┌──────────┐   ┌──────────────┐   ┌─────────────────────┐   │
        │  │ api/v1   │──▶│ services     │──▶│ repositories        │   │
        │  └──────────┘   └──────────────┘   └──────────┬──────────┘   │
        │                                               ▼               │
        │                                        SQLAlchemy + Alembic   │
        └───────────────────┬──────────────────────────┬────────────────┘
                            ▼                          ▼
                    ┌───────────────┐          ┌───────────────┐
                    │  PostgreSQL   │          │     Redis     │
                    └───────────────┘          └───────────────┘
```

Guiding principles:

- **Clean architecture** — thin routers → services → repositories → persistence.
- **Modular boundaries** — apps depend on `@agrovix/*` packages, never on each other.
- **Extensible auth** — user model designed so Google, Microsoft, Apple, phone-OTP, and
  other identity providers can be added later without a rewrite.
- **Portability first** — no cloud lock-in; standard Docker Compose spins up the entire stack.

## Repository Layout

```
.
├── apps/
│   ├── api/                # FastAPI backend (Python 3.12+)
│   ├── web/                # Next.js 14 web application (TypeScript)
│   └── mobile/             # Expo / React Native mobile app (TypeScript)
├── packages/
│   ├── ui/                 # @agrovix/ui           — shared UI primitives (web)
│   ├── types/              # @agrovix/types        — shared TypeScript types
│   ├── validation/         # @agrovix/validation   — Zod schemas shared with API
│   ├── utils/              # @agrovix/utils        — pure utility functions
│   └── config/             # @agrovix/config       — shared ESLint / TS / Tailwind config
├── .github/workflows/      # CI pipelines (GitHub Actions)
├── docker-compose.yml      # Local dev stack (postgres, redis, api, web)
├── turbo.json              # Turborepo task orchestration
├── pnpm-workspace.yaml     # pnpm workspaces manifest
├── tsconfig.base.json      # Shared strict TypeScript config
└── README.md
```

## Technology Stack

| Layer          | Technology                                       |
| -------------- | ------------------------------------------------ |
| Web            | Next.js 14 (App Router) · TypeScript · Tailwind · shadcn/ui |
| Mobile         | React Native · Expo SDK 51 · React Navigation    |
| Backend        | FastAPI · Python 3.12                            |
| Database       | PostgreSQL 16                                    |
| Cache / Queue  | Redis 7                                          |
| ORM            | SQLAlchemy 2 (async) · Alembic                   |
| Auth           | JWT (access + refresh) · bcrypt (passlib) · RBAC |
| Monorepo       | Turborepo · pnpm workspaces                      |
| CI             | GitHub Actions                                   |
| Container      | Docker · docker-compose                          |

## Prerequisites

- **Node.js** ≥ 20.x (LTS)
- **pnpm** ≥ 9.x — install via `corepack enable && corepack prepare pnpm@9.12.0 --activate`
- **Python** ≥ 3.12 (for the API app; local dev without Docker)
- **Docker** & **Docker Compose** (recommended for local database + full stack)
- **Expo CLI** — installed on demand via `pnpm --filter @agrovix/mobile dev`

## Quick Start (Local Development)

```bash
# Clone and enter the repository
git clone <your-fork-url> agrovix-agos
cd agrovix-agos

# First-time host setup
corepack enable && corepack prepare pnpm@9.12.0 --activate
pnpm install --frozen-lockfile

# Validate, start, and inspect the Compose-managed runtime
scripts/dev/check.sh
scripts/dev/start.sh
scripts/dev/status.sh
```

Docker Compose supervises PostgreSQL, Redis, FastAPI, and Next.js. The commands are the same
inside Codespaces; no custom Codespaces lifecycle hook or foreground terminal must remain open.
Normal browser traffic uses <http://localhost:3000>. API requests stay on that origin under
`/api-proxy/v1/...` and a server-side Next.js Route Handler forwards them to
`${API_PROXY_TARGET}/api/v1/...` over the Compose network.

On a new database, `start.sh` reports pending migrations without applying them. Apply them
explicitly, then inspect readiness again:

```bash
scripts/dev/migrate.sh       # asks for confirmation
scripts/dev/status.sh
```

## Environment Variables

Each surface has its own `.env.example`:

| File                       | Purpose                                     |
| -------------------------- | ------------------------------------------- |
| `.env.example`             | Root — global values used by docker-compose |
| `apps/api/.env.example`    | FastAPI backend                             |
| `apps/web/.env.example`    | Next.js public + server envs                |
| `apps/mobile/.env.example` | Expo app                                    |

**Never commit secrets.** Real `.env`, `.env.local`, `.env.*.local` files are ignored via `.gitignore`.

## Running with Docker Compose

```bash
# daily start (safe to repeat)
scripts/dev/start.sh

# rebuild after package.json, pnpm-lock.yaml, or Dockerfile changes
scripts/dev/start.sh --build

# status and logs
scripts/dev/status.sh
scripts/dev/logs.sh          # or: scripts/dev/logs.sh api

# stop only Agrovix services; preserve data
scripts/dev/stop.sh

# destructive reset; requires typed confirmation
scripts/dev/reset.sh
```

Diagnostic ports exposed on host loopback only:

| Service    | Host port | Container port |
| ---------- | --------- | -------------- |
| API        | 8000      | 8000           |
| Web        | 3000      | 3000           |

PostgreSQL and Redis are not published to the host. Each checkout derives a stable, path-specific
Compose project name, so its database and Redis volumes cannot collide with another checkout.
Set `AGROVIX_COMPOSE_PROJECT` to a valid lowercase Compose project name only when an explicit
override is needed. To inspect the current checkout through Compose, use its derived project:

```bash
project="$(bash -c 'source scripts/dev/common.sh; printf %s "$COMPOSE_PROJECT_NAME"')"
docker compose --project-name "$project" exec postgres psql -U agrovix -d agrovix_agos
docker compose --project-name "$project" exec redis redis-cli ping
```

Port 8000 is diagnostic only. Browser login, cookie refresh, and application requests use
`http://localhost:3000/api-proxy`; normal operation does not require opening port 8000.

## Common Commands

Run these from the **repo root**. The `dev:*` runtime commands use Docker Compose; build and
workspace-only commands use Turborepo where noted:

```bash
pnpm dev:start      # Compose-managed PostgreSQL + Redis + API + web
pnpm dev            # same canonical full-stack Compose start
pnpm dev:workspace  # legacy frontend/mobile workspace dev tasks via Turborepo
pnpm dev:check      # non-mutating host and Compose preflight
pnpm dev:status     # service, readiness, proxy, and migration status
pnpm dev:logs       # Compose logs (optionally pass a service via the shell script)
pnpm dev:stop       # stop services and preserve volumes
pnpm dev:migrate    # explicit, confirmed Alembic upgrade
pnpm dev:bootstrap-uat # explicit, secret-driven UAT bootstrap
pnpm dev:reset      # destructive data reset with confirmation
pnpm dev:web        # optional foreground host-only Next.js development
pnpm dev:mobile     # start only the Expo mobile app
pnpm build          # build every app (respecting the dep graph)
pnpm lint           # ESLint across all TS packages
pnpm format         # prettier --write everywhere
pnpm format:check   # prettier --check (CI)
pnpm type-check     # tsc --noEmit across all packages
pnpm test           # run all test suites
```

Python-only helpers (from `apps/api/`):

```bash
ruff check .        # lint
ruff check . --fix  # auto-fix
black .             # format
black --check .     # format check (CI)
pytest              # tests
alembic upgrade head        # apply migrations
alembic revision --autogenerate -m "message"   # create a migration
```

For the Compose runtime, prefer `scripts/dev/migrate.sh`; it uses the database URL already
configured inside the API container and verifies the final revision. UAT data is never created
automatically. Run `scripts/dev/bootstrap-uat.sh` only after migrations, supplying
`AGROVIX_UAT_PASSWORD` in the environment or through its hidden prompt.

If a service becomes unhealthy, inspect `scripts/dev/status.sh` and the relevant service log,
then run `scripts/dev/stop.sh` followed by `scripts/dev/start.sh`. This preserves data. Use
`reset.sh` only when loss of all local PostgreSQL and Redis data is intended.

The web development image contains its installed dependencies. Source directories are mounted
for hot reload, while `.next` stays in a container-only volume. After changing a package manifest,
`pnpm-lock.yaml`, or either development Dockerfile, run `scripts/dev/start.sh --build`; dependencies
are not installed on every container start.

## Backend (FastAPI) Details

The API lives in `apps/api` and exposes three baseline routes as required by Sprint 0:

| Method | Path       | Description                                     |
| ------ | ---------- | ----------------------------------------------- |
| GET    | `/`        | Service banner + links to docs                  |
| GET    | `/health`  | Liveness + DB / Redis readiness                 |
| GET    | `/version` | Semantic version, git commit, build info        |

Additional scaffolded auth endpoints (all under `/api/v1/auth`, business logic stubbed):

| Method | Path                         | Description                                            |
| ------ | ---------------------------- | ------------------------------------------------------ |
| POST   | `/api/v1/auth/register`      | Register a new user (email + password)                 |
| POST   | `/api/v1/auth/login`         | Issue access + refresh tokens                          |
| POST   | `/api/v1/auth/refresh`       | Rotate an access token via a valid refresh token       |
| POST   | `/api/v1/auth/logout`        | Revoke the current refresh token                       |
| GET    | `/api/v1/auth/me`            | Return the authenticated user (RBAC-protected route)   |

Architecture inside `apps/api/app/`:

```
app/
├── main.py                # FastAPI app factory + baseline routes
├── core/                  # config, security (JWT + hashing), logging
├── db/                    # SQLAlchemy engine, session, base
├── models/                # ORM models (User, Role, Permission, RefreshToken)
├── schemas/               # Pydantic v2 request/response models
├── repositories/          # Data access layer (one class per aggregate)
├── services/              # Business orchestration (auth_service, …)
├── api/v1/                # Versioned HTTP routers
└── deps.py                # FastAPI dependency-injection factories
```

## Web (Next.js) Details

The web shell lives in `apps/web` and uses the Next.js 14 App Router with TypeScript, Tailwind
CSS, and shadcn/ui. Sprint 0 ships the following pages:

| Route        | File                            | Purpose                         |
| ------------ | ------------------------------- | ------------------------------- |
| `/`          | `app/page.tsx`                  | Landing / marketing shell       |
| `/login`     | `app/login/page.tsx`            | Login form (calls API)          |
| `/register`  | `app/register/page.tsx`         | Registration form               |
| `/dashboard` | `app/dashboard/page.tsx`        | Placeholder authenticated area  |
| `*`          | `app/not-found.tsx`             | Custom 404                      |

State + API interaction is handled through a thin `lib/api.ts` client. Its default
`NEXT_PUBLIC_API_URL=/api-proxy` keeps cookies and requests on the web origin. The server-side
Route Handler maps browser `/api-proxy/v1/...` requests to `${API_PROXY_TARGET}/api/v1/...`.
Host-only Next.js uses `API_PROXY_TARGET=http://127.0.0.1:8000`; Compose overrides the target to
`http://api:8000`. `API_PROXY_TARGET` is server-only and must contain only the HTTP(S) upstream
origin, without `/api` or another path.

## Mobile (Expo / React Native) Details

`apps/mobile` is an Expo (SDK 51) TypeScript project. Sprint 0 screens:

| Screen        | Purpose                                     |
| ------------- | ------------------------------------------- |
| `Splash`      | App launch / bootstrap                      |
| `Login`       | Email + password sign-in                    |
| `Register`    | Account creation                            |
| `Dashboard`   | Placeholder authenticated area              |

Run the app:

```bash
pnpm dev:mobile
# or
cd apps/mobile && pnpm start
```

## Shared Packages

| Package                | Purpose                                                    |
| ---------------------- | ---------------------------------------------------------- |
| `@agrovix/ui`          | Cross-app React primitives (headless, styled by consumer). |
| `@agrovix/types`       | Domain-agnostic TypeScript types shared across apps.       |
| `@agrovix/validation`  | Zod schemas — the same schemas are consumed by the API.    |
| `@agrovix/utils`       | Framework-free utility functions (dates, formatters, …).   |
| `@agrovix/config`      | Shared ESLint / TypeScript / Tailwind presets.             |

## Continuous Integration

`.github/workflows/ci.yml` runs on every push and pull request:

1. Install pnpm workspace dependencies
2. Prettier format check
3. ESLint across every TS package
4. Type-check every TS package
5. Vitest unit tests (web + packages)
6. Web build verification (`next build`)
7. Ruff lint + Black format check (API)
8. Pytest with a real Postgres + Redis container
9. `pnpm audit` and `pip-audit` (non-blocking in Sprint 0)

No deployment jobs are configured yet — CD will be introduced once the architecture stabilises.

## Coding Standards

- **TypeScript**: `strict: true`, `noImplicitAny`, `noUnusedLocals`, `noUnusedParameters`.
- **Python**: Ruff (with `pycodestyle`, `pyflakes`, `isort`, `bugbear`, `pyupgrade`), Black,
  Pytest, PEP 484 type hints throughout.
- **Formatting**: Prettier (JS/TS/MD/YAML), Black (Python). CI enforces both.
- **Commits**: Conventional Commits recommended (`feat:`, `fix:`, `chore:`, …).
- **Testing**: Vitest for web/packages, Pytest for the API. Every new feature should ship
  with tests.

## License

Proprietary — © Agrovix. All rights reserved. See `LICENSE` if provided; otherwise treat as
unlicensed / internal use only.
