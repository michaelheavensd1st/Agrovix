"""Production Event catalog + per-event-type Pydantic schemas.

Every :class:`ProductionEvent` payload is validated by a schema
registered in :data:`CATALOG`. Unknown fields are rejected
(``extra="forbid"``); the validated dict is what gets persisted into
the ``data`` JSONB column. The registration is central so:

* the frontend can pull the JSON Schema per event type and generate
  forms + client-side validation from the same source of truth;
* analytics / warehousing consumers can rely on stable field names;
* new event types are added ONLY through platform releases (never at
  runtime by tenants).

Adding a new event type:

    class HarvestEventSchema(BaseModel):
        model_config = ConfigDict(extra="forbid")
        quantity: int = Field(ge=0)
        biomass_kg: float | None = None

    CATALOG.register("HARVEST", HarvestEventSchema, version=1, category="output")
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Type

from pydantic import BaseModel, ConfigDict, Field, ValidationError


# --------------------------------------------------------------------- #
# Per-event-type payload schemas
# --------------------------------------------------------------------- #
class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class StockingEventSchema(_StrictModel):
    quantity: int = Field(ge=1, description="Individuals stocked into the batch.")
    average_weight_g: float | None = Field(default=None, ge=0)
    source: str | None = Field(default=None, max_length=255, description="Hatchery / supplier reference.")


class FeedingEventSchema(_StrictModel):
    feed_kg: float = Field(gt=0)
    feed_type: str = Field(min_length=1, max_length=255)
    feeder_id: str | None = Field(default=None, max_length=255)


class MortalityEventSchema(_StrictModel):
    count: int = Field(ge=0)
    cause: str | None = Field(default=None, max_length=255)
    average_weight_g: float | None = Field(default=None, ge=0)


class SamplingEventSchema(_StrictModel):
    sample_size: int = Field(ge=1)
    average_weight_g: float = Field(ge=0)
    length_cm: float | None = Field(default=None, ge=0)


class WaterQualityEventSchema(_StrictModel):
    temperature_c: float | None = Field(default=None, ge=-5, le=60)
    ph: float | None = Field(default=None, ge=0, le=14)
    dissolved_oxygen_mg_l: float | None = Field(default=None, ge=0)
    salinity_ppt: float | None = Field(default=None, ge=0)
    ammonia_mg_l: float | None = Field(default=None, ge=0)
    nitrite_mg_l: float | None = Field(default=None, ge=0)
    notes: str | None = Field(default=None, max_length=1000)


class MedicationEventSchema(_StrictModel):
    substance: str = Field(min_length=1, max_length=255)
    dose: str = Field(min_length=1, max_length=255)
    route: str | None = Field(default=None, max_length=64)
    reason: str | None = Field(default=None, max_length=1000)


class TransferEventSchema(_StrictModel):
    quantity: int = Field(ge=1)
    destination_batch_id: str = Field(min_length=1, description="UUID of the target batch.")
    reason: str | None = Field(default=None, max_length=1000)


class HarvestEventSchema(_StrictModel):
    quantity: int = Field(ge=0)
    biomass_kg: float | None = Field(default=None, ge=0)
    is_final: bool = Field(default=False, description="If true, marks the terminal harvest for the batch.")


class InspectionEventSchema(_StrictModel):
    result: str = Field(min_length=1, max_length=64)
    findings: str | None = Field(default=None, max_length=2000)
    performed_by: str | None = Field(default=None, max_length=255)


# --------------------------------------------------------------------- #
# Catalog registry
# --------------------------------------------------------------------- #
@dataclass(frozen=True)
class EventCatalogEntry:
    code: str
    schema: Type[_StrictModel]
    version: int
    display_name: str
    category: str
    triggers_transition_to: str | None = None
    metadata: dict = field(default_factory=dict)

    def validate(self, data: dict) -> dict:
        """Validate + coerce ``data``. Raises :class:`pydantic.ValidationError`."""
        return self.schema.model_validate(data).model_dump(mode="json")

    def json_schema(self) -> dict:
        return self.schema.model_json_schema()


class ProductionEventCatalog:
    """Central registry of every supported production event type."""

    def __init__(self) -> None:
        self._entries: dict[str, EventCatalogEntry] = {}

    def register(
        self,
        code: str,
        schema: Type[_StrictModel],
        *,
        version: int = 1,
        display_name: str | None = None,
        category: str = "operational",
        triggers_transition_to: str | None = None,
        metadata: dict | None = None,
    ) -> EventCatalogEntry:
        entry = EventCatalogEntry(
            code=code.upper(),
            schema=schema,
            version=version,
            display_name=display_name or code.title(),
            category=category,
            triggers_transition_to=triggers_transition_to,
            metadata=metadata or {},
        )
        self._entries[entry.code] = entry
        return entry

    def get(self, code: str) -> EventCatalogEntry | None:
        return self._entries.get(code.upper())

    def require(self, code: str) -> EventCatalogEntry:
        entry = self.get(code)
        if entry is None:
            raise KeyError(f"Unknown production event type: {code!r}")
        return entry

    def codes(self) -> list[str]:
        return sorted(self._entries.keys())

    def as_openapi_catalog(self) -> list[dict]:
        return [
            {
                "code": e.code,
                "display_name": e.display_name,
                "category": e.category,
                "version": e.version,
                "triggers_transition_to": e.triggers_transition_to,
                "schema": e.json_schema(),
                "metadata": e.metadata,
            }
            for e in sorted(self._entries.values(), key=lambda x: x.code)
        ]


# --------------------------------------------------------------------- #
# The single, process-wide catalog. Import this — do NOT construct new
# instances at call sites.
# --------------------------------------------------------------------- #
CATALOG = ProductionEventCatalog()

CATALOG.register(
    "STOCKING", StockingEventSchema, version=1,
    display_name="Stocking", category="lifecycle",
    triggers_transition_to="stocked",
    metadata={"description": "Initial stocking of a batch into a unit."},
)
CATALOG.register("FEEDING", FeedingEventSchema, display_name="Feeding")
CATALOG.register("MORTALITY", MortalityEventSchema, display_name="Mortality")
CATALOG.register("SAMPLING", SamplingEventSchema, display_name="Sampling")
CATALOG.register("WATER_QUALITY", WaterQualityEventSchema, display_name="Water Quality")
CATALOG.register("MEDICATION", MedicationEventSchema, display_name="Medication")
CATALOG.register("TRANSFER", TransferEventSchema, display_name="Transfer")
CATALOG.register(
    "HARVEST", HarvestEventSchema, version=1,
    display_name="Harvest", category="lifecycle",
    triggers_transition_to="harvested",
    metadata={
        "description": "Harvest event. Batch transitions to HARVESTED only when is_final=true.",
        "transition_conditional_on": "is_final == true",
    },
)
CATALOG.register("INSPECTION", InspectionEventSchema, display_name="Inspection")


__all__ = [
    "CATALOG",
    "EventCatalogEntry",
    "ProductionEventCatalog",
    "StockingEventSchema",
    "FeedingEventSchema",
    "MortalityEventSchema",
    "SamplingEventSchema",
    "WaterQualityEventSchema",
    "MedicationEventSchema",
    "TransferEventSchema",
    "HarvestEventSchema",
    "InspectionEventSchema",
    "ValidationError",  # re-exported for callers that catch validation failures
]
