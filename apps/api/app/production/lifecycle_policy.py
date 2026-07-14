"""Central lifecycle policy for sites, units and batches.

Codex Review Gate 02 (final) — one source of truth for the
ACTIVE / MAINTENANCE / CLOSED behaviour of `ProductionSite` and
`ProductionUnit`. Every write path that touches a site, unit,
batch, transition or event routes through this module so the
semantics never drift between endpoints and services.

Guardrails encoded here:

* **CLOSED site / unit** — no writes at all. Cannot host new
  units or batches, cannot record events, cannot be transitioned
  manually, cannot be edited through PATCH (only a controlled
  reopen via `status`). CLOSED is terminal until explicit
  re-activation.
* **MAINTENANCE site / unit** — narrowly permitted writes.
  Events are limited to `WATER_QUALITY` + evacuating `TRANSFER`
  (the source unit must equal the batch's current unit). New
  units, batches and manual batch transitions are refused. PATCH
  is restricted to safe administrative metadata + the `status`
  field so the resource can be returned to ACTIVE.
* **ACTIVE site / unit** — normal behaviour.

The helpers raise `fastapi.HTTPException(409)` with a stable
error code so the frontend can localise and act on each policy
outcome deterministically.
"""

from __future__ import annotations

from collections.abc import Iterable

from fastapi import HTTPException, status

from app.models.production import (
    ProductionSite,
    ProductionSiteStatus,
    ProductionUnit,
    ProductionUnitStatus,
)


# --------------------------------------------------------------------- #
# Status coercion helpers
# --------------------------------------------------------------------- #
def _status_value(raw) -> str:
    """Return a lowercase string status regardless of enum/string origin."""
    if raw is None:
        return "active"
    return str(raw.value if hasattr(raw, "value") else raw).lower()


def is_active(site_or_unit: ProductionSite | ProductionUnit) -> bool:
    return _status_value(getattr(site_or_unit, "status", None)) == "active"


def is_maintenance(site_or_unit: ProductionSite | ProductionUnit) -> bool:
    return _status_value(getattr(site_or_unit, "status", None)) == "maintenance"


def is_closed(site_or_unit: ProductionSite | ProductionUnit) -> bool:
    return _status_value(getattr(site_or_unit, "status", None)) == "closed"


# --------------------------------------------------------------------- #
# Reason helpers so error codes stay uniform across call sites.
# --------------------------------------------------------------------- #
def _raise_closed(resource: str, action: str) -> None:
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "code": f"{resource}_closed_no_writes",
            "message": (
                f"Cannot {action} — the {resource} is CLOSED and read-only. "
                "Re-activate the resource first."
            ),
            "resource": resource,
        },
    )


def _raise_maintenance(resource: str, action: str, allowed: Iterable[str] | None = None) -> None:
    detail: dict = {
        "code": f"{resource}_under_maintenance",
        "message": (
            f"Cannot {action} — the {resource} is under MAINTENANCE. "
            "Wait for the maintenance window to end or return the "
            "resource to ACTIVE first."
        ),
        "resource": resource,
    }
    if allowed is not None:
        detail["allowed_actions"] = sorted(allowed)
    raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


# --------------------------------------------------------------------- #
# Creation gates
# --------------------------------------------------------------------- #
def assert_can_create_unit_in_site(site: ProductionSite) -> None:
    """Block new unit creation when the parent site is not ACTIVE."""
    if is_closed(site):
        _raise_closed("site", "create a production unit")
    if is_maintenance(site):
        _raise_maintenance("site", "create a production unit")


def assert_can_create_batch(site: ProductionSite, unit: ProductionUnit) -> None:
    """Block new batch creation when the parent site OR unit isn't ACTIVE."""
    if is_closed(site):
        _raise_closed("site", "start a batch")
    if is_closed(unit):
        _raise_closed("unit", "start a batch")
    if is_maintenance(site):
        _raise_maintenance("site", "start a batch")
    if is_maintenance(unit):
        _raise_maintenance("unit", "start a batch")


# --------------------------------------------------------------------- #
# Manual transition gate (event-driven transitions are still governed
# by the event lifecycle policy in ProductionEventService).
# --------------------------------------------------------------------- #
def assert_can_manually_transition(site: ProductionSite, unit: ProductionUnit) -> None:
    if is_closed(site):
        _raise_closed("site", "transition the batch")
    if is_closed(unit):
        _raise_closed("unit", "transition the batch")
    if is_maintenance(site):
        _raise_maintenance("site", "transition the batch")
    if is_maintenance(unit):
        _raise_maintenance("unit", "transition the batch")


def assert_batch_update_allowed(site: ProductionSite, unit: ProductionUnit) -> None:
    """Gate PATCH /batches/{id} on the parent site + unit lifecycle.

    Policy (Codex Review Gate 02 final follow-up):

    * CLOSED site or unit → refuse *any* batch update. CLOSED is
      read-only until an explicit reopen; batch mutations while the
      parent is CLOSED would sidestep the read-only invariant.
    * MAINTENANCE site or unit → refuse batch updates. Sprint 3
      hasn't documented a "batch admin metadata allow-list" separate
      from the batch schema, so we refuse the whole PATCH surface
      while the parent is under maintenance and defer that
      allow-list to a follow-on sprint.
    * ACTIVE site + ACTIVE unit → normal update rules apply.
    """
    if is_closed(site):
        _raise_closed("site", "update the batch")
    if is_closed(unit):
        _raise_closed("unit", "update the batch")
    if is_maintenance(site):
        _raise_maintenance("site", "update the batch")
    if is_maintenance(unit):
        _raise_maintenance("unit", "update the batch")


def assert_site_delete_allowed(site: ProductionSite) -> None:
    """Delete is a write. A CLOSED site must be reopened first.

    Rationale: CLOSED is read-only until an explicit reopen. Deletion
    would violate that invariant and skip the "reopen under normal
    safeguards → then delete" flow the lifecycle policy is designed
    to preserve.
    """
    if is_closed(site):
        _raise_closed("site", "delete the site")


def assert_unit_delete_allowed(unit: ProductionUnit) -> None:
    if is_closed(unit):
        _raise_closed("unit", "delete the unit")


# --------------------------------------------------------------------- #
# Update gates — PATCH endpoints
# --------------------------------------------------------------------- #
# Fields safe to change while the resource is under MAINTENANCE. The
# `status` field is always accepted so callers can move the resource
# back to ACTIVE. Anything not in this allow-list is refused so we
# never mutate physical / structural attributes while operations
# are paused.
_MAINTENANCE_ALLOWED_SITE_FIELDS = frozenset(
    {
        "status",
        "name",
        "description",
        "address",
        "timezone",
        "manager_id",
        "metadata_json",
    }
)

_MAINTENANCE_ALLOWED_UNIT_FIELDS = frozenset(
    {
        "status",
        "name",
        "metadata_json",
    }
)


def assert_site_update_allowed(site: ProductionSite, changed_fields: Iterable[str]) -> None:
    """Enforce update policy for CLOSED / MAINTENANCE sites.

    * CLOSED: only `status` may be changed (controlled reopen).
    * MAINTENANCE: only the fields in `_MAINTENANCE_ALLOWED_SITE_FIELDS`.
    """
    changed = set(changed_fields)
    if not changed:
        return
    if is_closed(site):
        disallowed = changed - {"status"}
        if disallowed:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "site_closed_no_writes",
                    "message": (
                        "A CLOSED site cannot be edited — only a controlled "
                        "reopen via `status` is allowed."
                    ),
                    "disallowed_fields": sorted(disallowed),
                },
            )
    elif is_maintenance(site):
        disallowed = changed - _MAINTENANCE_ALLOWED_SITE_FIELDS
        if disallowed:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "site_under_maintenance",
                    "message": (
                        "A MAINTENANCE site only accepts safe administrative "
                        "edits plus the `status` field."
                    ),
                    "disallowed_fields": sorted(disallowed),
                    "allowed_fields": sorted(_MAINTENANCE_ALLOWED_SITE_FIELDS),
                },
            )


def assert_unit_update_allowed(unit: ProductionUnit, changed_fields: Iterable[str]) -> None:
    changed = set(changed_fields)
    if not changed:
        return
    if is_closed(unit):
        disallowed = changed - {"status"}
        if disallowed:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "unit_closed_no_writes",
                    "message": (
                        "A CLOSED unit cannot be edited — only a controlled "
                        "reopen via `status` is allowed."
                    ),
                    "disallowed_fields": sorted(disallowed),
                },
            )
    elif is_maintenance(unit):
        disallowed = changed - _MAINTENANCE_ALLOWED_UNIT_FIELDS
        if disallowed:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                {
                    "code": "unit_under_maintenance",
                    "message": (
                        "A MAINTENANCE unit only accepts safe administrative "
                        "edits plus the `status` field."
                    ),
                    "disallowed_fields": sorted(disallowed),
                    "allowed_fields": sorted(_MAINTENANCE_ALLOWED_UNIT_FIELDS),
                },
            )


# --------------------------------------------------------------------- #
# Event lifecycle gate
# --------------------------------------------------------------------- #
#: Codes the maintenance write allow-list accepts unconditionally.
#: TRANSFER is added dynamically ONLY when the source unit is the
#: unit currently under maintenance (evacuation).
_MAINTENANCE_ALLOWED_EVENTS = frozenset({"WATER_QUALITY"})


def assert_event_allowed_by_lifecycle(
    *,
    site: ProductionSite,
    unit: ProductionUnit,
    event_code: str,
    source_unit_id: str | None = None,
) -> None:
    """Central event-lifecycle gate used by ProductionEventService.

    * CLOSED site/unit → reject every event with a stable error code.
    * MAINTENANCE site/unit → allow WATER_QUALITY unconditionally and
      TRANSFER only when the source_unit_id matches the batch's
      current unit (i.e. this is an evacuation OUT of the resource
      under maintenance).
    """
    event_code = event_code.upper()

    # CLOSED — always refuse writes.
    for label, resource in (("site", site), ("unit", unit)):
        if is_closed(resource):
            _raise_closed(label, f"log a {event_code} event")

    # MAINTENANCE — narrow allow-list.
    allowed = set(_MAINTENANCE_ALLOWED_EVENTS)
    if event_code == "TRANSFER" and source_unit_id and str(source_unit_id) == str(unit.id):
        allowed.add("TRANSFER")

    for label, resource in (("site", site), ("unit", unit)):
        if is_maintenance(resource) and event_code not in allowed:
            _raise_maintenance(label, f"log a {event_code} event", allowed=allowed)


__all__ = [
    "ProductionSiteStatus",
    "ProductionUnitStatus",
    "assert_batch_update_allowed",
    "assert_can_create_batch",
    "assert_can_create_unit_in_site",
    "assert_can_manually_transition",
    "assert_event_allowed_by_lifecycle",
    "assert_site_delete_allowed",
    "assert_site_update_allowed",
    "assert_unit_delete_allowed",
    "assert_unit_update_allowed",
    "is_active",
    "is_closed",
    "is_maintenance",
]
