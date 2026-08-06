# Release 6.0.2 — Business Partners

Vertical slice #1 of Release 6.0 (Purchase-to-Stock). Introduces the
**Business Partner** aggregate that all Purchase Orders, Purchase
Receipts, and future partner-facing workflows will hang off. This
release ships only the partner aggregate and its supplier-oriented UI;
Purchase Orders and Purchase Receipts stay out of scope.

Canonical contract: [`docs/architecture/release-6.0-purchase-to-stock.md`](../architecture/release-6.0-purchase-to-stock.md).

## §4.1 Partner header contract

| Field | Type | Notes |
| --- | --- | --- |
| `code` | `VARCHAR(64)` | Uppercased, regex `^[A-Z0-9][A-Z0-9._-]{0,63}$`; unique within an organization across ALL lifecycle states (never recycled). |
| `legal_name` | `VARCHAR(255)` | Required, non-blank. |
| `trading_name` | `VARCHAR(255)` | Optional. |
| `primary_address` | `JSONB` | Bounded object with the frozen keys `{line1, line2, city, region, postal_code, country_code}`. Extra keys are rejected (`extra="forbid"`). `country_code` inside is ISO 3166-1 alpha-2. |
| `email` | `VARCHAR(320)` | Optional partner-level convenience contact. Does NOT replace multi-contact. |
| `phone` | `VARCHAR(80)` | Optional partner-level convenience contact. |
| `country_code` | `CHAR(2)` | Optional ISO 3166-1 alpha-2 (uppercased at the API layer; length enforced at the DB layer). |
| `tax_identifier` | `VARCHAR(80)` | Optional reference identifier. Not interpreted (no tax logic). |
| `notes` | `VARCHAR(2000)` | Optional free text. |
| `metadata` | `JSONB` | Bounded (≤ 4 KiB serialised); no keys matching `password/secret/token/api_key/credential/authorization`; not for secrets, not for audit-payload duplication. Intended use: presentation hints, external-system correlation IDs. |
| `is_active` | `BOOLEAN` | Lifecycle state (deactivate / restore are idempotent). |

## Concepts

| Concept | Location | Notes |
| --- | --- | --- |
| **Business Partner** | `business_partners` | Aggregate root, organization-owned, `code` unique within an organization across all lifecycle states. |
| **Capabilities** | `business_partner_capabilities` | A partner may be a supplier, customer, transporter, contractor, veterinary service, laboratory, consultant, or other. Multiple capabilities are supported on a single partner. |
| **Supplier profile** | `business_partner_supplier_profiles` | One-to-one with a partner that has the `supplier` capability. Carries qualification status + preference tier. |
| **Contacts** | `business_partner_contacts` | Named contacts with a role. At most one *active primary* contact is allowed per `(partner, role)`. |

**Frozen enums** (do not extend without an architecture pass):

- `BusinessPartnerCapabilityCode` — `supplier`, `customer`, `transporter`, `contractor`, `veterinary_service`, `laboratory`, `consultant`, `other`
- `BusinessPartnerQualificationStatus` — `unqualified`, `approved`, `blocked`
- `BusinessPartnerPreferenceTier` — `standard`, `preferred`
- `BusinessPartnerContactRole` — `accounts`, `warehouse`, `sales`, `driver`, `managing_director`, `technical`, `other`

## Business rules

1. **Code normalization**: `code` is uppercased and validated against `^[A-Z0-9][A-Z0-9._-]{0,63}$` on write.
2. **Unique code per organization**: enforced by a UNIQUE constraint across *all* lifecycle states — codes are never recycled.
3. **Non-empty invariant**: `code` and `legal_name` are enforced non-blank at the DB layer via CHECK constraints and at the API layer via schema validators.
4. **Supplier profile requires supplier capability**: writing a supplier profile without the `supplier` capability returns a frozen 409 `supplier_profile_requires_supplier_capability` envelope.
5. **Qualification is server-controlled**: setting `qualification_status` to anything other than `unqualified` stamps `qualified_by_id` and `qualified_at` from the acting user; resetting to `unqualified` clears both.
6. **Preference is independent of qualification**: preference tier may change without a qualification change; qualification changes emit a dedicated audit event.
7. **At most one active primary contact per role**: enforced with a partial unique index (`is_primary AND is_active AND deleted_at IS NULL`).
8. **Removing the supplier capability** deletes the associated supplier profile so subsequent qualification reads return 404.
9. **History-safe lifecycle**: `deactivate` / `restore` flip `is_active` and reason columns idempotently — no hard delete API is exposed.

## API surface (§11.2)

Aggregate:

- `GET  /api/v1/organizations/{organization_id}/business-partners` — list with cursor pagination, filters `capability`, `active`, `qualification`, `preference`, `search`.
- `POST /api/v1/organizations/{organization_id}/business-partners` — atomic create (partner + capabilities + supplier profile + contacts).
- `GET  /api/v1/business-partners/{partner_id}`
- `PATCH /api/v1/business-partners/{partner_id}` — partner-header fields only.
- `POST /api/v1/business-partners/{partner_id}/deactivate`
- `POST /api/v1/business-partners/{partner_id}/restore`

Capabilities:

- `GET    /api/v1/business-partners/{partner_id}/capabilities`
- `POST   /api/v1/business-partners/{partner_id}/capabilities`
- `DELETE /api/v1/business-partners/{partner_id}/capabilities/{capability}`

Supplier profile:

- `GET /api/v1/business-partners/{partner_id}/supplier-profile`
- `PUT /api/v1/business-partners/{partner_id}/supplier-profile`

Contacts:

- `GET  /api/v1/business-partners/{partner_id}/contacts` — cursor pagination; `include_inactive`.
- `POST /api/v1/business-partners/{partner_id}/contacts`
- `GET  /api/v1/business-partner-contacts/{contact_id}`
- `PATCH /api/v1/business-partner-contacts/{contact_id}`
- `POST /api/v1/business-partner-contacts/{contact_id}/deactivate`
- `POST /api/v1/business-partner-contacts/{contact_id}/restore`

**Error envelope** (§11.1):

```json
{
  "detail": {
    "code": "business_partner_code_conflict",
    "message": "A partner with this code already exists in this organization.",
    "context": {"code": "ACME-01"}
  }
}
```

**Cursor**: opaque, deterministic, tie-broken on the UUID PK:

```
next_cursor = base64url("<legal_name>|<uuid>")
```

Malformed cursor → `HTTP 422 { code: "invalid_cursor" }`.

## Authorization

Permissions (all organization-scoped):

- `business_partner.read`
- `business_partner.create`
- `business_partner.update`
- `business_partner.deactivate`

Role grants (per canonical §12):

| Role | read | create | update | deactivate |
| --- | :-: | :-: | :-: | :-: |
| `owner` | ✅ | ✅ | ✅ | ✅ |
| `farm_director` | ✅ | ✅ | ✅ | ❌ |
| `farm_manager` | ✅ (scoped) | ❌ | ❌ | ❌ |
| `supervisor` | ✅ (scoped) | ❌ | ❌ | ❌ |
| `storekeeper` | ✅ (scoped) | ❌ | ❌ | ❌ |
| `accountant` | ✅ | ❌ | ❌ | ❌ |
| `viewer` | ✅ | ❌ | ❌ | ❌ |

**Tenant isolation**: non-members of the owning organization receive a 404 (existence hidden). The endpoint layer first loads the partner and then hands the resolved `organization_id` to `require_permission`, whose membership check runs before the permission code check.

## Audit trail

Every mutation emits an `AuditEvent` with `entity_type=business_partner` and one of:

- `business_partner.create`
- `business_partner.update`
- `business_partner.deactivate` / `business_partner.restore`
- `business_partner.capability.add` / `business_partner.capability.remove`
- `business_partner.qualification.update`
- `business_partner.contact.create` / `.update` / `.deactivate` / `.restore`

> `contact.restore` is an implementation clarification — it mirrors the partner-level `deactivate/restore` symmetry so history-safe undo of a contact deactivation is auditable. The architecture doc §4.5 lists `contact.create/update/deactivate` explicitly; the additional `contact.restore` action is a superset, not a new permission (all four are gated by `business_partner.update`).

Metadata is **bounded** — never full request payloads, never contact emails/phones/notes. Only a compact summary (changed field names, counts, capability codes, reasons up to 500 chars) is stored.

## UI

Routes (all under `apps/web/app/business-partners/`):

- `/business-partners` — list. Supplier-oriented BY DEFAULT (`capability` filter pre-selected to `supplier`), with search + active + qualification + preference filters and cursor pagination.
- `/business-partners/new` — create form. The `supplier` capability is pre-checked and a supplier-profile section is exposed accordingly.
- `/business-partners/{id}` — detail view with capabilities, supplier profile, contacts, and permission-aware actions (edit / deactivate / restore / add capability / add contact / qualification update).
- `/business-partners/{id}/edit` — header edit form (code is immutable).

Test IDs follow the `bp-*` convention (`bp-create-link`, `bp-row-{code}`, `bp-filter-capability`, `bp-detail-capability-{code}`, etc.) so end-to-end tests can drive the pages deterministically.

## Testing

- **Backend**: `apps/api/tests/test_business_partners.py` — 29 integration tests covering create, read, list filters/pagination, PATCH header, deactivate/restore, capability CRUD (including supplier→profile purge), supplier profile upsert with qualification stamping, contact CRUD + primary invariant, cross-tenant hiding, permission gating (viewer + farm_director), and audit-trail completeness with bounded metadata.
- **Frontend**: `apps/web/tests/business-partners.test.tsx` — 10 Vitest + Testing Library tests covering list rendering with supplier-default filter, create-link visibility gate on permission, filter propagation to the API query string, 403 banner, create form submission with supplier capability + profile, 409 error envelope surfacing, and detail-page states (active vs inactive, 404).

## Out of scope for 6.0.2

- Purchase Orders and Purchase Receipts (Release 6.0.3 / 6.0.4).
- Enforcement of "cannot remove `supplier` capability while active non-terminal purchasing documents exist" — the extension point is wired in the service (see `remove_capability`); enforcement lands with Release 6.0.3.
- Multi-currency, banking, or tax-registration fields on the partner header.
