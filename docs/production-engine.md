# The Production Engine

The **Production Engine** is the species-agnostic core of Agrovix.
Instead of separate tables for hatcheries, ponds, batches and
species-specific event logs, everything operational flows through a
single, uniform hierarchy:

```
Organization
    ↓
  Farm
    ↓
  ProductionSite      ← a physical operating location
    ↓
  ProductionUnit      ← tank / pond / cage / raceway / biofloc
    ↓
  ProductionBatch     ← a stocking cycle with a typed lifecycle
    ↓
  ProductionEvent     ← append-only operational activity
```

Every operational activity is a **`ProductionEvent`** with an
event-type code drawn from a small, platform-owned catalog. One
table, one API, one permission model, one audit model, one event
stream.

## Why one engine

Aquaculture is not the only production model Agrovix will need to
support: shrimp hatcheries, tilapia grow-out cages, and future
livestock or agri operations all reduce to the same abstraction.
Baking that generality in from Sprint 2 avoids a disruptive rewrite
later and keeps the platform's operational analytics uniform.

## Reference data

| Entity                | Ownership                  | Extensibility                                                     |
| --------------------- | -------------------------- | ----------------------------------------------------------------- |
| `ProductionUnitType`  | System-seeded + org-custom | Orgs create their own custom types; system types are immutable    |
| `ProductionEventType` | System-owned (catalog)     | Platform releases only — orgs cannot create or rename event types |

System-seeded unit types (see `app/seed.py`):

- `HATCHERY_TANK`, `NURSERY_TANK`, `GROW_OUT_POND`, `CAGE`, `RACEWAY`, `BIOFLOC_TANK`

Registered event types (see `app/production/event_catalog.py`):

- `STOCKING`, `FEEDING`, `MORTALITY`, `SAMPLING`, `WATER_QUALITY`,
  `MEDICATION`, `TRANSFER`, `HARVEST`, `INSPECTION`

## Event validation

Every event's payload is validated against a `Pydantic BaseModel`
registered in `CATALOG`. Unknown fields are **forbidden** (`extra="forbid"`).
On failure, the API returns `422` with a field-level error list so the
UI can highlight the offending inputs precisely:

```json
{
  "detail": {
    "event_type": "FEEDING",
    "errors": [{ "field": "feed_kg", "message": "Input should be greater than 0", "type": "greater_than" }]
  }
}
```

The frontend can pull the JSON Schema for each event type from
`GET /api/v1/production-events/catalog` and generate forms from it.

## Batch state machine

```
                     ┌──── CANCELLED (from PLANNED only)
                     │
     PLANNED ────▶ STOCKED ────▶ ACTIVE ──▶ HARVESTED ──▶ CLOSED
                       │              │
                       └── SUSPENDED ─┘        └── FAILED
                             ↕
                        (ACTIVE ⇄ SUSPENDED)
```

Enforcement rules:

- State changes go **only** through `ProductionBatchService`. Direct
  updates to `state` are not exposed via the update endpoint.
- Every transition uses a compare-and-swap update
  (`WHERE state = <expected>`). Two concurrent transitions on the
  same batch produce exactly **one 200 and one 409** — never a corrupt
  state.
- `PLANNED → STOCKED` and `ACTIVE → HARVESTED` are **event-driven** —
  they can only be reached by logging a `STOCKING` or
  `HARVEST (is_final=true)` event. Attempting them via
  `POST /batches/{id}/transitions` returns `409`.
- `HARVESTED → CLOSED` is an explicit reconciliation transition.
- Every transition is recorded in `production_batch_transitions`
  (append-only history) and also mirrored into `audit_events`.
- Once a batch is in a terminal state (`CLOSED`, `CANCELLED`, `FAILED`)
  new events cannot be logged against it (`409`).

## Storage layout

- `production_events` is **append-only** and partition-ready.
  `performed_at` is the future partition key.
- Composite index `(batch_id, performed_at, id)` supports the
  cursor-paginated `GET /batches/{id}/events` list. Ordering is
  `performed_at DESC, id DESC` for stability under identical
  timestamps.
- `organization_id`, `farm_id` and `site_id` are **denormalised**
  onto every event so tenant isolation, filtering and future
  partitioning do not require joins.
- Postgres uses `JSONB` for `data` and `attachments`; SQLite tests
  transparently fall back to `JSON`.

## API surface

```
# Sites
POST   /api/v1/farms/{farm_id}/sites
GET    /api/v1/farms/{farm_id}/sites
GET    /api/v1/sites/{site_id}
PATCH  /api/v1/sites/{site_id}
DELETE /api/v1/sites/{site_id}
POST   /api/v1/sites/{site_id}/restore

# Unit types (system + org custom)
GET    /api/v1/production-unit-types
POST   /api/v1/organizations/{org_id}/production-unit-types
DELETE /api/v1/production-unit-types/{id}

# Units
POST   /api/v1/sites/{site_id}/units
GET    /api/v1/sites/{site_id}/units
GET    /api/v1/units/{unit_id}
PATCH  /api/v1/units/{unit_id}
DELETE /api/v1/units/{unit_id}

# Batches
POST   /api/v1/units/{unit_id}/batches
GET    /api/v1/units/{unit_id}/batches
GET    /api/v1/batches/{batch_id}
PATCH  /api/v1/batches/{batch_id}
POST   /api/v1/batches/{batch_id}/transitions
GET    /api/v1/batches/{batch_id}/transitions

# Events
GET    /api/v1/production-events/catalog
POST   /api/v1/batches/{batch_id}/events
GET    /api/v1/batches/{batch_id}/events   # cursor pagination
GET    /api/v1/events/{event_id}
```

## Permissions

New codes (see `app/security/permissions.py`):

- `production_site.{read,create,update,delete,restore}`
- `production_unit_type.{read,create,delete}`
- `production_unit.{read,create,update,delete}`
- `production_batch.{read,create,update,transition}`
- `production_event.{read,create}`

Distribution to system roles:

- `organization_owner` — all Production Engine permissions
- `farm_director` — everything except type deletion + site delete
- `farm_manager` — day-to-day site + unit + batch + event management
- `supervisor` / `storekeeper` / `veterinarian` / `worker` — read
  most rows, create events
- `viewer` / `accountant` — read-only

## Future work (deferred, not built)

- Table partitioning on `production_events` (monthly or quarterly).
  The schema is designed for it — apply
  `ALTER TABLE ... PARTITION BY RANGE (performed_at)` in a later
  migration when volume warrants it.
- Attachment storage (S3/GCS). Currently only attachment metadata
  is accepted; actual file transport lands with the file-service.
- GIN indexes on `data` for specific field queries (only when
  concrete query shapes are known).
