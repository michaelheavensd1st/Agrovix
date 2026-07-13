# PRD — Agrovix AgOS Sprint 0 (Foundation)

## Original Problem Statement
Build an enterprise-grade Agricultural Operating System (AgOS) using a monorepo architecture.
Sprint 0 = project foundation only (no farm business features). Deliverables:
- Turborepo + pnpm monorepo
- FastAPI backend with `/`, `/health`, `/version`
- Web (Next.js + TS + Tailwind + shadcn) shell: Landing, Login, Register, Dashboard, 404
- Mobile (Expo/RN) shell: Splash, Login, Register, Dashboard
- Shared packages: `@agrovix/ui`, `@agrovix/types`, `@agrovix/validation`, `@agrovix/utils`, `@agrovix/config`
- PostgreSQL + Redis (docker-compose)
- SQLAlchemy + Alembic
- JWT + refresh tokens + password hashing + RBAC + revocation store
- GitHub Actions CI (lint, format, type-check, tests, build, audit)
- ESLint, Prettier, Ruff, Black, Pytest, Vitest
- Docker Compose + Dockerfiles
- README with setup

## User Choices
- Platform: Web (Next.js) + Mobile (Expo) scaffolding, per spec
- Auth: JWT email/password only (Google/etc later)
- Monorepo: Turborepo + pnpm workspaces
- CI: Lint + format + type + tests + web build + audit; no CD yet
- Package namespace: `@agrovix/*`

## Architecture Delivered
```
/app
├── apps/
│   ├── api/       FastAPI + SQLAlchemy async + Alembic + JWT + bcrypt + RBAC
│   ├── web/       Next.js 14 (App Router) + TS + Tailwind
│   └── mobile/    Expo SDK 51 + RN + React Navigation
├── packages/
│   ├── ui/        cn() + <Button/> primitive
│   ├── types/     Shared TS types (PublicUser, TokenPair, …)
│   ├── validation/Zod schemas mirroring API
│   ├── utils/     Pure helpers (formatDate, assertDefined, …)
│   └── config/    ESLint / Tailwind / TS presets
├── .github/workflows/ci.yml
├── docker-compose.yml (postgres 16, redis 7, api, web)
├── turbo.json, pnpm-workspace.yaml, tsconfig.base.json
├── README.md (full setup docs)
├── backend/server.py   ← pod live-preview shim
└── frontend/*          ← pod live-preview CRA mirror of the Next.js pages
```

## What's Implemented (2026-02)
- **Backend** (`apps/api`)
  - App factory, config (pydantic-settings), structured logging
  - Baseline routes: `/`, `/health`, `/version`
  - v1 routes: `/api/v1/health/`, `/api/v1/health/ready`, `/api/v1/version/`
  - Auth routes: `/register`, `/login`, `/refresh`, `/logout`, `/me`
  - SQLAlchemy async models: User, Role, Permission, RefreshToken + associations
  - Repositories (UserRepository, RefreshTokenRepository)
  - AuthService with bcrypt hashing + JWT (access + refresh) + hashed refresh-token store + rotation
  - RBAC dependency (`require_roles(*)`)
  - Alembic initial migration
  - Pytest tests (health, version, password hashing, JWT round-trip)
  - Dockerfile
- **Web** (`apps/web`)
  - App Router with Landing, Login, Register, Dashboard, 404
  - Tailwind + shadcn-style CSS variables
  - Fetch-based API client + AuthForm component
  - Vitest tests
  - Dockerfile
- **Mobile** (`apps/mobile`)
  - Expo + RN + React Navigation
  - Splash, Login, Register, Dashboard screens
- **Shared packages** — all wired via workspace protocol
- **CI** — GitHub Actions with install → lint → type-check → test → web build → audit → API ruff/black/pytest with real Postgres+Redis service containers
- **Docker Compose** — Postgres + Redis + API + Web
- **Pod live-preview** — `/app/backend/server.py` (FastAPI shim) + `/app/frontend` (CRA mirror) so the Emergent pod serves the AgOS pages/endpoints without needing pnpm/Next.js/Postgres inside the container

## Personas
- Backend engineer / platform engineer setting up Agrovix Sprint 0 skeleton
- Frontend engineer needing landing/auth pages to build upon
- Mobile engineer needing Expo scaffold with navigation
- QA/DevOps validating CI + Docker Compose

## Backlog (P0 → P2)
- **P0** Business models: Farm, Field, Crop, Season, Team + relationships
- **P0** Real DB-backed auth flows in-pod (currently pod uses in-memory shim; canonical apps/api runs on Postgres)
- **P1** SSO providers (Google, Microsoft, Apple), phone OTP
- **P1** Observability: OpenTelemetry, JSON logs, Prometheus metrics
- **P1** Object storage integration for farm imagery/documents
- **P2** CD pipelines (staging + prod, per-app), Terraform infra
- **P2** Feature flags, i18n, audit log

## Next Actions
1. Add farm-domain models (Farm, Field, Crop, Season) + migrations
2. Seed a canonical superuser + default roles (`admin`, `farm_manager`, `field_worker`)
3. Wire the Next.js web app to a real API base URL + token persistence
4. Introduce structured request/response logging
