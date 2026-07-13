"""Production Engine services.

Contains the business rules for sites, unit types, units, batches
(including the state machine) and events (including catalog validation
and event → transition wiring).

The state machine (see :class:`ProductionBatchService`) is the trickiest
piece. It uses a compare-and-swap primitive
(:meth:`ProductionBatchRepository.compare_and_set_state`) so that two
concurrent transitions on the same batch produce exactly one success
and one 409 — never a corrupt final state.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import HTTPException, status
from pydantic import ValidationError

from app.models.audit import AuditEvent
from app.models.farm import Farm
from app.models.production import (
    ProductionBatch,
    ProductionBatchState,
    ProductionEvent,
    ProductionSite,
    ProductionSiteStatus,
    ProductionUnit,
    ProductionUnitStatus,
    ProductionUnitType,
)
from app.models.user import User
from app.production.event_catalog import CATALOG, EventCatalogEntry
from app.repositories.audit_repo import AuditRepository
from app.repositories.production import (
    ProductionBatchRepository,
    ProductionBatchTransitionRepository,
    ProductionEventRepository,
    ProductionSiteRepository,
    ProductionUnitRepository,
    ProductionUnitTypeRepository,
)


# --------------------------------------------------------------------- #
# ProductionSite service
# --------------------------------------------------------------------- #
class ProductionSiteService:
    def __init__(
        self,
        *,
        site_repo: ProductionSiteRepository,
        unit_repo: ProductionUnitRepository,
        audit_repo: AuditRepository,
    ) -> None:
        self.site_repo = site_repo
        self.unit_repo = unit_repo
        self.audit_repo = audit_repo

    async def create(
        self, *, actor: User, farm: Farm, data: dict, request_ctx: dict, is_default: bool = False
    ) -> ProductionSite:
        site = await self.site_repo.create(
            farm_id=farm.id,
            is_default=is_default,
            **data,
        )
        await self.audit_repo.record(
            actor_id=actor.id if actor else None,
            action="production_site.create",
            entity_type="production_site",
            entity_id=str(site.id),
            organization_id=farm.organization_id,
            farm_id=farm.id,
            **request_ctx,
        )
        return site

    async def soft_delete(
        self, *, actor: User, site: ProductionSite, farm: Farm, request_ctx: dict
    ) -> None:
        # Guardrail: refuse when any active units exist (per Sprint 2 spec).
        active_units = await self.site_repo.count_active_units(site.id)
        if active_units > 0:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"Cannot delete site while {active_units} active production unit(s) exist "
                f"underneath it. Delete or move the units first.",
            )
        if site.deleted_at is not None:
            return  # idempotent
        await self.site_repo.soft_delete(site)
        await self.audit_repo.record(
            actor_id=actor.id, action="production_site.delete",
            entity_type="production_site", entity_id=str(site.id),
            organization_id=farm.organization_id, farm_id=farm.id, **request_ctx,
        )

    async def restore(
        self, *, actor: User, site: ProductionSite, farm: Farm, request_ctx: dict
    ) -> ProductionSite:
        if site.deleted_at is None:
            return site
        await self.site_repo.restore(site)
        await self.audit_repo.record(
            actor_id=actor.id, action="production_site.restore",
            entity_type="production_site", entity_id=str(site.id),
            organization_id=farm.organization_id, farm_id=farm.id, **request_ctx,
        )
        return site


# --------------------------------------------------------------------- #
# ProductionUnitType service
# --------------------------------------------------------------------- #
class ProductionUnitTypeService:
    def __init__(
        self,
        *,
        unit_type_repo: ProductionUnitTypeRepository,
        audit_repo: AuditRepository,
    ) -> None:
        self.unit_type_repo = unit_type_repo
        self.audit_repo = audit_repo

    async def create_custom(
        self, *, actor: User, organization_id: uuid.UUID, data: dict, request_ctx: dict
    ) -> ProductionUnitType:
        # System-owned codes cannot be shadowed by custom types.
        if await self.unit_type_repo.system_code_exists(data["code"]):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"Code {data['code']!r} is reserved by a system-owned production unit type.",
            )
        row = await self.unit_type_repo.create(
            organization_id=organization_id, is_system=False, **data
        )
        await self.audit_repo.record(
            actor_id=actor.id, action="production_unit_type.create",
            entity_type="production_unit_type", entity_id=str(row.id),
            organization_id=organization_id, **request_ctx,
        )
        return row

    async def delete_custom(
        self, *, actor: User, row: ProductionUnitType, request_ctx: dict
    ) -> None:
        if row.is_system:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "System production unit types cannot be deleted.",
            )
        if row.deleted_at is not None:
            return
        await self.unit_type_repo.soft_delete(row)
        await self.audit_repo.record(
            actor_id=actor.id, action="production_unit_type.delete",
            entity_type="production_unit_type", entity_id=str(row.id),
            organization_id=row.organization_id, **request_ctx,
        )


# --------------------------------------------------------------------- #
# ProductionUnit service
# --------------------------------------------------------------------- #
class ProductionUnitService:
    def __init__(
        self,
        *,
        unit_repo: ProductionUnitRepository,
        unit_type_repo: ProductionUnitTypeRepository,
        site_repo: ProductionSiteRepository,
        audit_repo: AuditRepository,
    ) -> None:
        self.unit_repo = unit_repo
        self.unit_type_repo = unit_type_repo
        self.site_repo = site_repo
        self.audit_repo = audit_repo

    async def create(
        self,
        *,
        actor: User,
        site: ProductionSite,
        farm: Farm,
        data: dict,
        request_ctx: dict,
    ) -> ProductionUnit:
        if site.deleted_at is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Cannot add a production unit to a deleted site. Restore the site first.",
            )
        # Verify the type is visible to this org (system or their own).
        unit_type = await self.unit_type_repo.get_visible(
            data["unit_type_id"], organization_id=farm.organization_id
        )
        if unit_type is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Unknown or inaccessible production unit type.",
            )
        unit = await self.unit_repo.create(site_id=site.id, **data)
        await self.audit_repo.record(
            actor_id=actor.id, action="production_unit.create",
            entity_type="production_unit", entity_id=str(unit.id),
            organization_id=farm.organization_id, farm_id=farm.id, **request_ctx,
        )
        return unit

    async def soft_delete(
        self,
        *,
        actor: User,
        unit: ProductionUnit,
        farm: Farm,
        request_ctx: dict,
    ) -> None:
        active_batches = await self.unit_repo.count_active_batches(unit.id)
        if active_batches > 0:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"Cannot delete a unit with {active_batches} active batch(es). "
                "Close or transfer the batches first.",
            )
        if unit.deleted_at is not None:
            return
        await self.unit_repo.soft_delete(unit)
        await self.audit_repo.record(
            actor_id=actor.id, action="production_unit.delete",
            entity_type="production_unit", entity_id=str(unit.id),
            organization_id=farm.organization_id, farm_id=farm.id, **request_ctx,
        )


# --------------------------------------------------------------------- #
# ProductionBatch service — the state machine lives here
# --------------------------------------------------------------------- #

# Allowed transitions. Absence == 409 Conflict. Tuples are (from, to).
_ALLOWED_TRANSITIONS: dict[ProductionBatchState, set[ProductionBatchState]] = {
    ProductionBatchState.PLANNED: {
        ProductionBatchState.STOCKED,
        ProductionBatchState.CANCELLED,
    },
    ProductionBatchState.STOCKED: {
        ProductionBatchState.ACTIVE,
        ProductionBatchState.SUSPENDED,
    },
    ProductionBatchState.ACTIVE: {
        ProductionBatchState.HARVESTED,
        ProductionBatchState.SUSPENDED,
        ProductionBatchState.FAILED,
    },
    ProductionBatchState.SUSPENDED: {
        ProductionBatchState.ACTIVE,
        ProductionBatchState.FAILED,
        ProductionBatchState.CANCELLED,
    },
    ProductionBatchState.HARVESTED: {
        ProductionBatchState.CLOSED,
    },
    # Terminal states — no outbound transitions.
    ProductionBatchState.CLOSED: set(),
    ProductionBatchState.CANCELLED: set(),
    ProductionBatchState.FAILED: set(),
}

# Certain transitions can only be reached via a specific event type.
_EVENT_DRIVEN_TRANSITIONS: dict[
    tuple[ProductionBatchState, ProductionBatchState], str
] = {
    (ProductionBatchState.PLANNED, ProductionBatchState.STOCKED): "STOCKING",
    (ProductionBatchState.ACTIVE, ProductionBatchState.HARVESTED): "HARVEST",
}

_TERMINAL_STATES = {
    ProductionBatchState.CLOSED,
    ProductionBatchState.CANCELLED,
    ProductionBatchState.FAILED,
}


class ProductionBatchService:
    def __init__(
        self,
        *,
        batch_repo: ProductionBatchRepository,
        transition_repo: ProductionBatchTransitionRepository,
        unit_repo: ProductionUnitRepository,
        audit_repo: AuditRepository,
    ) -> None:
        self.batch_repo = batch_repo
        self.transition_repo = transition_repo
        self.unit_repo = unit_repo
        self.audit_repo = audit_repo

    async def create(
        self,
        *,
        actor: User,
        unit: ProductionUnit,
        farm: Farm,
        data: dict,
        request_ctx: dict,
    ) -> ProductionBatch:
        if unit.deleted_at is not None or unit.status == ProductionUnitStatus.CLOSED:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Cannot start a batch in a deleted or closed production unit.",
            )
        batch = await self.batch_repo.create(
            unit_id=unit.id, state=ProductionBatchState.PLANNED, **data
        )
        # Record the initial transition (from=None) so history is complete.
        await self.transition_repo.record(
            batch_id=batch.id,
            from_state=None,
            to_state=ProductionBatchState.PLANNED,
            actor_id=actor.id,
        )
        await self.audit_repo.record(
            actor_id=actor.id, action="production_batch.create",
            entity_type="production_batch", entity_id=str(batch.id),
            organization_id=farm.organization_id, farm_id=farm.id, **request_ctx,
        )
        return batch

    def _validate_transition(
        self,
        *,
        current: ProductionBatchState,
        target: ProductionBatchState,
        triggering_event: ProductionEvent | None,
    ) -> None:
        if current == target:
            # Idempotent same-state transition — noop, not a failure.
            return
        allowed = _ALLOWED_TRANSITIONS.get(current, set())
        if target not in allowed:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"Invalid batch transition {current.value} → {target.value}.",
            )
        required_event = _EVENT_DRIVEN_TRANSITIONS.get((current, target))
        if required_event and (
            triggering_event is None or triggering_event.event_type != required_event
        ):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"Transition {current.value} → {target.value} requires a "
                f"{required_event} event to trigger it.",
            )

    async def transition(
        self,
        *,
        actor: User,
        batch: ProductionBatch,
        farm: Farm,
        target_state: ProductionBatchState,
        reason: str | None = None,
        request_ctx: dict,
        triggering_event: ProductionEvent | None = None,
        metadata: dict | None = None,
    ) -> ProductionBatch:
        current = batch.state
        self._validate_transition(
            current=current, target=target_state, triggering_event=triggering_event
        )
        if current == target_state:
            return batch

        # Timestamps for lifecycle milestones.
        now = datetime.now(timezone.utc)
        ts_fields: dict[str, datetime] = {}
        if target_state == ProductionBatchState.STOCKED:
            ts_fields["stocked_at"] = now
        elif target_state == ProductionBatchState.HARVESTED:
            ts_fields["harvested_at"] = now
        elif target_state == ProductionBatchState.CLOSED:
            ts_fields["closed_at"] = now

        succeeded = await self.batch_repo.compare_and_set_state(
            batch.id, from_state=current, to_state=target_state, timestamp_fields=ts_fields,
        )
        if not succeeded:
            # Another caller transitioned the batch first.
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Batch state changed concurrently. Reload and try again.",
            )

        # Reflect the new state on the in-memory ORM instance for the caller.
        batch.state = target_state
        for k, v in ts_fields.items():
            setattr(batch, k, v)

        await self.transition_repo.record(
            batch_id=batch.id,
            from_state=current,
            to_state=target_state,
            actor_id=actor.id,
            event_id=triggering_event.id if triggering_event else None,
            reason=reason,
            metadata=metadata,
        )
        await self.audit_repo.record(
            actor_id=actor.id, action="production_batch.transition",
            entity_type="production_batch", entity_id=str(batch.id),
            organization_id=farm.organization_id, farm_id=farm.id,
            metadata={"from": current.value, "to": target_state.value, "reason": reason},
            **request_ctx,
        )
        return batch


# --------------------------------------------------------------------- #
# ProductionEvent service — validates payload + drives batch transitions
# --------------------------------------------------------------------- #
class ProductionEventService:
    def __init__(
        self,
        *,
        event_repo: ProductionEventRepository,
        batch_repo: ProductionBatchRepository,
        batch_service: ProductionBatchService,
        unit_repo: ProductionUnitRepository,
        site_repo: ProductionSiteRepository,
        audit_repo: AuditRepository,
    ) -> None:
        self.event_repo = event_repo
        self.batch_repo = batch_repo
        self.batch_service = batch_service
        self.unit_repo = unit_repo
        self.site_repo = site_repo
        self.audit_repo = audit_repo

    async def create(
        self,
        *,
        actor: User,
        batch: ProductionBatch,
        unit: ProductionUnit,
        site: ProductionSite,
        farm: Farm,
        payload: dict,
        request_ctx: dict,
    ) -> ProductionEvent:
        if batch.state in _TERMINAL_STATES:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"Cannot log new events on a {batch.state.value} batch.",
            )

        # ---- Catalog validation ---------------------------------- #
        code = str(payload.get("event_type", "")).upper()
        entry: EventCatalogEntry | None = CATALOG.get(code)
        if entry is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"Unknown event_type {code!r}. Registered types: {', '.join(CATALOG.codes())}.",
            )
        try:
            validated_data = entry.validate(payload.get("data") or {})
        except ValidationError as exc:
            # Emit field-level errors so the UI can surface them precisely.
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={
                    "event_type": entry.code,
                    "errors": [
                        {
                            "field": ".".join(str(p) for p in err["loc"]),
                            "message": err["msg"],
                            "type": err["type"],
                        }
                        for err in exc.errors()
                    ],
                },
            ) from exc

        # Determine is_final flag for events that carry one (e.g. HARVEST).
        is_final = bool(validated_data.get("is_final", False))

        event = await self.event_repo.create(
            organization_id=farm.organization_id,
            farm_id=farm.id,
            site_id=site.id,
            unit_id=unit.id,
            batch_id=batch.id,
            event_type=entry.code,
            event_type_version=entry.version,
            performed_by_id=actor.id,
            performed_at=payload.get("performed_at") or datetime.now(timezone.utc),
            data=validated_data,
            attachments=payload.get("attachments"),
            is_final=is_final,
            notes=payload.get("notes"),
        )
        await self.audit_repo.record(
            actor_id=actor.id, action="production_event.create",
            entity_type="production_event", entity_id=str(event.id),
            organization_id=farm.organization_id, farm_id=farm.id,
            metadata={"event_type": entry.code}, **request_ctx,
        )

        # ---- Optional lifecycle transition ----------------------- #
        if entry.triggers_transition_to is not None:
            target = ProductionBatchState(entry.triggers_transition_to)
            # HARVEST only closes the batch when marked final.
            if entry.code == "HARVEST" and not is_final:
                pass
            elif batch.state != target and target in _ALLOWED_TRANSITIONS.get(batch.state, set()):
                await self.batch_service.transition(
                    actor=actor, batch=batch, farm=farm, target_state=target,
                    reason=f"triggered by {entry.code} event",
                    request_ctx=request_ctx, triggering_event=event,
                )
        return event

    async def list_for_batch(
        self, batch: ProductionBatch, *, limit: int, cursor: str | None, event_type: str | None
    ) -> tuple[list[ProductionEvent], str | None]:
        return await self.event_repo.list_for_batch(
            batch.id, limit=limit, cursor=cursor, event_type=event_type,
        )
