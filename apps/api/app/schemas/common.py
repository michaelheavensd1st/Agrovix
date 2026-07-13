"""Common / shared response schemas."""

from __future__ import annotations

from pydantic import BaseModel, Field


class MessageResponse(BaseModel):
    message: str = Field(..., examples=["ok"])


class PageMeta(BaseModel):
    total: int
    limit: int
    offset: int
