"""API v1 root router."""

from __future__ import annotations

from fastapi import APIRouter

from app.api.v1.endpoints import auth, health, version

api_v1_router = APIRouter()

api_v1_router.include_router(health.router, prefix="/health", tags=["health"])
api_v1_router.include_router(version.router, prefix="/version", tags=["version"])
api_v1_router.include_router(auth.router, prefix="/auth", tags=["auth"])
