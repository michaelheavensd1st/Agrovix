# Test Credentials — Agrovix AgOS

## Overview
Sprint 1 introduces **email verification** and **httpOnly cookie auth**. No
seeded accounts exist by default. There is no default superuser — one is
created via `python -m app.cli create_admin` (interactive prompt).

For local development, `apps/api/.env` includes `ALLOW_UNVERIFIED_LOGIN=false`
by default. Tests set this to `true` for the hermetic suite. Registered
accounts must open the verification URL that appears in the API log
before they can log in.

## Sprint 4 E2E test account (live on local dev API @ http://127.0.0.1:8055)

| Field       | Value                                    |
| ----------- | ---------------------------------------- |
| Email       | `e2e@agrovix.dev`                        |
| Password    | `testtest123`                            |
| Organization| `E2E Farm` (slug `e2e-farm`)             |
| Warehouse   | `Main Store` (code `MAIN`)               |
| Item        | `Grower crumble` (code `FEED-01`, kg)    |
| Lot         | `LOT001` (100 kg)                        |

This account is verified and has organization_owner scope on `E2E Farm`.
It is created against the local development database `agrovix_dev` on
Postgres `localhost:5432`, backed by the `apps/api` uvicorn process on
port 8055 spun up during Sprint 4 M4 validation.

## Login form data-testids (apps/web)
- Email input: `auth-email-input`
- Password input: `auth-password-input`
- Submit button: `login-submit-button`
- Full name (register only): `auth-fullname-input`
- Register submit: `register-submit-button`

## Inventory workspace data-testids
- Page root: `inventory-page`
- Tabs: `inv-tab-overview` | `inv-tab-warehouses` | `inv-tab-items` |
        `inv-tab-lots` | `inv-tab-receive` | `inv-tab-issue` |
        `inv-tab-transfer` | `inv-tab-adjust` | `inv-tab-history`
- Warehouse form: `inv-warehouse-new`, `inv-warehouse-name`,
  `inv-warehouse-code`, `inv-warehouse-submit`, `inv-warehouse-search`
- Item form: `inv-item-new`, `inv-item-code`, `inv-item-name`,
  `inv-item-category`, `inv-item-unit`, `inv-item-submit`,
  `inv-item-search`, `inv-item-filter-category`
- Receive: `inv-receive-form`, `inv-receive-warehouse`, `inv-receive-item`,
  `inv-receive-lot-code`, `inv-receive-quantity`, `inv-receive-unit`,
  `inv-receive-submit`
- Issue: `inv-issue-form`, `inv-issue-lot`, `inv-issue-qty`, `inv-issue-unit`,
  `inv-issue-reason`, `inv-issue-submit`, `inv-issue-confirm-confirm`
- Adjust: `inv-adjust-form`, `inv-adjust-lot`, `inv-adjust-direction`,
  `inv-adjust-qty`, `inv-adjust-unit`, `inv-adjust-reason`,
  `inv-adjust-submit`, `inv-adjust-confirm-confirm`
- Transfer: `inv-transfer-form`, `inv-transfer-lot`,
  `inv-transfer-destination`, `inv-transfer-qty`, `inv-transfer-unit`,
  `inv-transfer-submit`
- History: `inv-history-lot`, `inv-history-filter-type`, `inv-history`
- Toaster: `ui-toaster`, `ui-toast-success`, `ui-toast-error`
- Confirm dialog: `ui-confirm`, `ui-confirm-confirm`, `ui-confirm-cancel`

## Recommended test flow

1. `curl` register: `POST /api/v1/auth/register` with `{email, password >=8, full_name}`
2. Look at the API JSON log for a `email.dispatch` line — the `context.verify_url` field is your link.
3. `POST /api/v1/auth/verify` with `{token: "..."}` (or open the URL in the web app).
4. `POST /api/v1/auth/login` — the response sets httpOnly cookies (`agrovix_access`, `agrovix_refresh`) and returns `{token_type, expires_in}`.
5. Subsequent requests should be made with the cookies attached; the Next.js client sends `credentials: 'include'` automatically.
