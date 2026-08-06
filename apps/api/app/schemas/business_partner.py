"""Release 6.0.2 — Business Partner schemas."""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

from app.models.business_partner import (
    BusinessPartnerCapabilityCode,
    BusinessPartnerContactRole,
    BusinessPartnerPreferenceTier,
    BusinessPartnerQualificationStatus,
)

# Frozen sizing — matches migration 0011 columns exactly.
_CODE_RE = re.compile(r"^[A-Z0-9][A-Z0-9._\-]{0,63}$")
_COUNTRY_CODE_RE = re.compile(r"^[A-Z]{2}$")
# §4.1 — bounded presentation metadata: cap the serialised JSONB at
# 4 KiB so nothing unbounded ever reaches the DB.
_METADATA_MAX_BYTES = 4096
_METADATA_FORBIDDEN_KEYS = frozenset(
    {"password", "secret", "token", "api_key", "credential", "authorization"}
)


def _normalise_country_code(v: str | None) -> str | None:
    if v is None:
        return None
    v = v.strip().upper()
    if not v:
        return None
    if not _COUNTRY_CODE_RE.match(v):
        raise ValueError("country_code must be ISO 3166-1 alpha-2 (two uppercase letters).")
    return v


class PartnerAddress(BaseModel):
    """§4.1 primary_address — bounded structured JSONB with the frozen keys."""

    model_config = ConfigDict(extra="forbid")

    line1: str | None = Field(default=None, max_length=255)
    line2: str | None = Field(default=None, max_length=255)
    city: str | None = Field(default=None, max_length=120)
    region: str | None = Field(default=None, max_length=120)
    postal_code: str | None = Field(default=None, max_length=40)
    country_code: str | None = Field(default=None, min_length=2, max_length=2)

    @field_validator("line1", "line2", "city", "region", "postal_code", mode="before")
    @classmethod
    def _strip_or_null(cls, v: Any) -> Any:
        if isinstance(v, str):
            v = v.strip()
            return v or None
        return v

    @field_validator("country_code")
    @classmethod
    def _iso_country(cls, v: str | None) -> str | None:
        return _normalise_country_code(v)


def _validate_metadata(value: Any) -> dict | None:
    """Bounded, structured, non-secret JSONB per §4.1."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("metadata must be a JSON object.")
    for key in value:
        if not isinstance(key, str):
            raise ValueError("metadata keys must be strings.")
        low = key.lower()
        if any(banned in low for banned in _METADATA_FORBIDDEN_KEYS):
            raise ValueError(f"metadata key '{key}' is forbidden (looks like a secret).")
    encoded = json.dumps(value, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > _METADATA_MAX_BYTES:
        raise ValueError(f"metadata exceeds the {_METADATA_MAX_BYTES}-byte bound.")
    return value


class ErrorContext(BaseModel):
    """Bounded, tenant-safe context. Never contains foreign IDs."""

    model_config = ConfigDict(extra="allow")


# --------------------------------------------------------------------- #
# Public read shapes.
# --------------------------------------------------------------------- #
class BusinessPartnerCapabilityPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    business_partner_id: uuid.UUID
    capability: BusinessPartnerCapabilityCode
    created_at: datetime


class BusinessPartnerSupplierProfilePublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    business_partner_id: uuid.UUID
    qualification_status: BusinessPartnerQualificationStatus
    qualification_note: str | None
    qualified_by_id: uuid.UUID | None
    qualified_at: datetime | None
    preference_tier: BusinessPartnerPreferenceTier
    created_at: datetime
    updated_at: datetime


class BusinessPartnerContactPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    business_partner_id: uuid.UUID
    name: str
    job_title: str | None
    email: str | None
    phone: str | None
    contact_role: BusinessPartnerContactRole
    is_primary: bool
    is_active: bool
    notes: str | None
    deactivated_at: datetime | None
    deactivation_reason: str | None
    created_at: datetime
    updated_at: datetime


class BusinessPartnerPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: uuid.UUID
    organization_id: uuid.UUID
    code: str
    legal_name: str
    trading_name: str | None
    primary_address: PartnerAddress | None = None
    email: str | None
    phone: str | None
    country_code: str | None
    tax_identifier: str | None
    notes: str | None
    metadata: dict | None = Field(
        default=None,
        validation_alias="metadata_json",
        serialization_alias="metadata",
    )
    is_active: bool
    deactivated_at: datetime | None
    deactivation_reason: str | None
    created_at: datetime
    updated_at: datetime

    capabilities: list[BusinessPartnerCapabilityPublic] = Field(default_factory=list)
    supplier_profile: BusinessPartnerSupplierProfilePublic | None = None
    contacts: list[BusinessPartnerContactPublic] = Field(default_factory=list)


class CursorPage(BaseModel):
    """Frozen list-response envelope — §11.1."""

    items: list
    next_cursor: str | None = None


# --------------------------------------------------------------------- #
# Create / update contracts.
# --------------------------------------------------------------------- #
class BusinessPartnerContactCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    job_title: str | None = Field(default=None, max_length=255)
    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=80)
    contact_role: BusinessPartnerContactRole
    is_primary: bool = False
    notes: str | None = Field(default=None, max_length=2000)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        stripped = v.strip()
        if not stripped:
            raise ValueError("name must not be blank.")
        return stripped


class BusinessPartnerSupplierProfileWriteRequest(BaseModel):
    qualification_status: BusinessPartnerQualificationStatus = (
        BusinessPartnerQualificationStatus.UNQUALIFIED
    )
    qualification_note: str | None = Field(default=None, max_length=2000)
    preference_tier: BusinessPartnerPreferenceTier = BusinessPartnerPreferenceTier.STANDARD


class BusinessPartnerCreateRequest(BaseModel):
    code: str = Field(min_length=1, max_length=64)
    legal_name: str = Field(min_length=1, max_length=255)
    trading_name: str | None = Field(default=None, max_length=255)
    primary_address: PartnerAddress | None = None
    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=80)
    country_code: str | None = Field(default=None, min_length=2, max_length=2)
    tax_identifier: str | None = Field(default=None, max_length=80)
    notes: str | None = Field(default=None, max_length=2000)
    metadata: dict | None = None

    capabilities: list[BusinessPartnerCapabilityCode] = Field(
        default_factory=list,
        description="Initial capabilities. Duplicates are dropped.",
    )
    supplier_profile: BusinessPartnerSupplierProfileWriteRequest | None = None
    contacts: list[BusinessPartnerContactCreateRequest] = Field(default_factory=list)

    @field_validator("code")
    @classmethod
    def _normalise_code(cls, v: str) -> str:
        v = v.strip().upper()
        if not _CODE_RE.match(v):
            raise ValueError("code must match ^[A-Z0-9][A-Z0-9._-]{0,63}$.")
        return v

    @field_validator("legal_name")
    @classmethod
    def _strip_legal(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("legal_name must not be blank.")
        return v

    @field_validator("country_code")
    @classmethod
    def _iso_country(cls, v: str | None) -> str | None:
        return _normalise_country_code(v)

    @field_validator("tax_identifier", "phone", mode="before")
    @classmethod
    def _strip_or_null(cls, v: Any) -> Any:
        if isinstance(v, str):
            v = v.strip()
            return v or None
        return v

    @field_validator("metadata")
    @classmethod
    def _validate_metadata(cls, v: dict | None) -> dict | None:
        return _validate_metadata(v)


class BusinessPartnerUpdateRequest(BaseModel):
    """PATCH — partner-header fields only.

    Capability / supplier profile / contact mutations go through
    dedicated sub-resource endpoints per Phase 0 clarification.
    """

    model_config = ConfigDict(extra="forbid")

    legal_name: str | None = Field(default=None, min_length=1, max_length=255)
    trading_name: str | None = Field(default=None, max_length=255)
    primary_address: PartnerAddress | None = None
    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=80)
    country_code: str | None = Field(default=None, min_length=2, max_length=2)
    tax_identifier: str | None = Field(default=None, max_length=80)
    notes: str | None = Field(default=None, max_length=2000)
    metadata: dict | None = None

    @field_validator("country_code")
    @classmethod
    def _iso_country(cls, v: str | None) -> str | None:
        return _normalise_country_code(v)

    @field_validator("tax_identifier", "phone", mode="before")
    @classmethod
    def _strip_or_null(cls, v: Any) -> Any:
        if isinstance(v, str):
            v = v.strip()
            return v or None
        return v

    @field_validator("metadata")
    @classmethod
    def _validate_metadata(cls, v: dict | None) -> dict | None:
        return _validate_metadata(v)

    @model_validator(mode="after")
    def _at_least_one_field(self) -> BusinessPartnerUpdateRequest:
        # Empty PATCH body is still valid (idempotent no-op); no assertion.
        return self


class BusinessPartnerDeactivateRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=500)


class BusinessPartnerRestoreRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=500)


class BusinessPartnerCapabilityAddRequest(BaseModel):
    capability: BusinessPartnerCapabilityCode


class BusinessPartnerContactUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    job_title: str | None = Field(default=None, max_length=255)
    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=80)
    contact_role: BusinessPartnerContactRole | None = None
    is_primary: bool | None = None
    notes: str | None = Field(default=None, max_length=2000)


class BusinessPartnerContactDeactivateRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=500)


class BusinessPartnerContactRestoreRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=500)


__all__ = [
    "BusinessPartnerCapabilityAddRequest",
    "BusinessPartnerCapabilityPublic",
    "BusinessPartnerContactCreateRequest",
    "BusinessPartnerContactDeactivateRequest",
    "BusinessPartnerContactPublic",
    "BusinessPartnerContactRestoreRequest",
    "BusinessPartnerContactUpdateRequest",
    "BusinessPartnerCreateRequest",
    "BusinessPartnerDeactivateRequest",
    "BusinessPartnerPublic",
    "BusinessPartnerRestoreRequest",
    "BusinessPartnerSupplierProfilePublic",
    "BusinessPartnerSupplierProfileWriteRequest",
    "BusinessPartnerUpdateRequest",
    "CursorPage",
    "PartnerAddress",
]
