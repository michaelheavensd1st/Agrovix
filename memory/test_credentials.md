# Test Credentials — Agrovix AgOS (Sprint 0 foundation)

## Overview
Sprint 0 ships an authentication **scaffold only** (register / login / refresh / logout).
No seeded accounts exist by default. Every test must register its own user first.

## Recommended test account (register-then-use)

- **email**: `qa+agos@agrovix.dev`
- **password**: `SprintZero!2026`
- **full_name**: `AgOS QA`

## Endpoints (relative to `REACT_APP_BACKEND_URL`)

| Method | Path                        | Notes                                 |
| ------ | --------------------------- | ------------------------------------- |
| GET    | `/`                         | Service banner                        |
| GET    | `/health`                   | Liveness — `{"status":"ok"}`          |
| GET    | `/version`                  | Service version metadata              |
| GET    | `/api/v1/health/`           | v1 liveness                           |
| GET    | `/api/v1/health/ready`      | DB + Redis readiness (shim reports ok)|
| GET    | `/api/v1/version/`          | Detailed version metadata             |
| POST   | `/api/v1/auth/register`     | `{email, password, full_name?}`       |
| POST   | `/api/v1/auth/login`        | `{email, password}` → `{access_token, refresh_token, expires_in, token_type}` |
| POST   | `/api/v1/auth/refresh`      | `{refresh_token}`                     |
| POST   | `/api/v1/auth/logout`       | `{refresh_token}`                     |
| GET    | `/api/v1/auth/me`           | Returns the most recently registered user (pod shim behavior) |
