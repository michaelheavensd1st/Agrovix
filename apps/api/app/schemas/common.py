"""Common / shared response schemas."""

from __future__ import annotations

from pydantic import BaseModel, Field


class MessageResponse(BaseModel):
    """Generic success envelope."""

    message: str = Field(..., examples=["ok"])
