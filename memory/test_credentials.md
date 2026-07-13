# Test Credentials — Agrovix AgOS (Sprint 1)

## Overview
Sprint 1 introduces **email verification** and **httpOnly cookie auth**. No
seeded accounts exist by default. There is no default superuser — one is
created via `python -m app.cli create_admin` (interactive prompt).

For local development, `apps/api/.env` includes `ALLOW_UNVERIFIED_LOGIN=false`
by default. Tests set this to `true` for the hermetic suite. Registered
accounts must open the verification URL that appears in the API log
before they can log in.

## Recommended test flow

1. `curl` register: `POST /api/v1/auth/register` with `{email, password >=8, full_name}`
2. Look at the API JSON log for a `email.dispatch` line — the `context.verify_url` field is your link.
3. `POST /api/v1/auth/verify` with `{token: "..."}` (or open the URL in the web app).
4. `POST /api/v1/auth/login` — the response sets httpOnly cookies (`agrovix_access`, `agrovix_refresh`) and returns `{token_type, expires_in}`.
5. Subsequent requests should be made with the cookies attached; the Next.js client sends `credentials: 'include'` automatically.

## Endpoints (relative to `REACT_APP_BACKEND_URL`)

| Method | Path                                                       | Notes                                                        |
| ------ | ---------------------------------------------------------- | ------------------------------------------------------------ |
| POST   | `/api/v1/auth/register`                                    | Creates user, dispatches verify email                        |
| POST   | `/api/v1/auth/verify`                                      | Confirms email via `{token}`                                 |
| POST   | `/api/v1/auth/resend-verification`                         | Silent no-op on unknown emails                               |
| POST   | `/api/v1/auth/login`                                       | Sets httpOnly cookies                                        |
| POST   | `/api/v1/auth/refresh`                                     | Rotates refresh (cookie or body)                             |
| POST   | `/api/v1/auth/logout`                                      | Clears cookies + revokes                                     |
| GET    | `/api/v1/auth/me`                                          | Protected                                                    |
| POST   | `/api/v1/organizations`                                    | Creator becomes `organization_owner`                         |
| GET    | `/api/v1/organizations`                                    | Lists only orgs the user belongs to                          |
| GET    | `/api/v1/organizations/{organization_id}`                  | 404 if not a member (no leak)                                |
| POST   | `/api/v1/organizations/{organization_id}/farms`            | Requires `farm.create`                                       |
| GET    | `/api/v1/organizations/{organization_id}/farms`            | Scoped to caller's role assignments                          |
| GET    | `/api/v1/farms/{farm_id}`                                  | 404 if not a member                                          |
| POST   | `/api/v1/organizations/{organization_id}/invitations`      | Requires `invitation.create`                                 |
| POST   | `/api/v1/invitations/accept`                               | Actor must match invitation email                            |
| POST   | `/api/v1/invitations/{invitation_id}/revoke`               | Requires `invitation.revoke`                                 |
| POST   | `/api/v1/organizations/{organization_id}/role-assignments` | Requires `organization.role.assign`                          |
| DELETE | `/api/v1/role-assignments/{assignment_id}`                 | Blocks orphaning last `organization_owner`                   |
| GET    | `/api/v1/organizations/{organization_id}/audit-events`     | Requires `audit.read`                                        |

## Pod preview

The Emergent pod URL runs a **preview shim** (see `/app/PREVIEW_SHIM.md`).
It exposes the Sprint 0 endpoint surface only — the Sprint 1 endpoints
above run against the canonical Postgres-backed API in `apps/api`.
