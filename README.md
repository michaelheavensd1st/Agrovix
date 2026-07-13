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
# 1. Clone & enter
git clone <your-fork-url> agrovix-agos
cd agrovix-agos

# 2. Enable pnpm via corepack
corepack enable && corepack prepare pnpm@9.12.0 --activate

# 3. Install JS/TS dependencies for all workspaces
pnpm install

# 4. Copy env templates
cp .env.example .env
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
cp apps/mobile/.env.example apps/mobile/.env

# 5. Start Postgres + Redis (via Docker)
docker compose up -d postgres redis

# 6. Setup Python API (in another terminal)
cd apps/api
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
alembic upgrade head
uvicorn app.main:app --reload --port 8000

# 7. Start the web app (from repo root)
pnpm dev:web             # → http://localhost:3000

# 8. Start the mobile app (optional)
pnpm dev:mobile          # → Expo dev tools
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
# spin up the full stack
docker compose up --build

# just infrastructure (recommended while developing locally)
docker compose up -d postgres redis

# tear everything down (keeps volumes)
docker compose down

# tear everything down (drops data volumes)
docker compose down -v
```

Ports exposed on the host:

| Service    | Host port | Container port |
| ---------- | --------- | -------------- |
| Postgres   | 5432      | 5432           |
| Redis      | 6379      | 6379           |
| API        | 8000      | 8000           |
| Web        | 3000      | 3000           |

## Common Commands

Run these from the **repo root** (they use Turborepo to fan out):

```bash
pnpm dev            # start every app in parallel (web + api + mobile)
pnpm dev:web        # start only the Next.js web app
pnpm dev:api        # start only the FastAPI backend
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

State + API interaction is handled through a thin `lib/api.ts` client (fetch-based) that reads
`NEXT_PUBLIC_API_URL` at runtime.

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
