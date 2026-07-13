"""API v1 root router."""

from __future__ import annotations

from fastapi import APIRouter

from app.api.v1.endpoints import (
    audit,
    auth,
    farms,
    health,
    invitations,
    organizations,
    production,
    role_assignments,
    version,
)

api_v1_router = APIRouter()

api_v1_router.include_router(health.router, prefix="/health", tags=["health"])
api_v1_router.include_router(version.router, prefix="/version", tags=["version"])
api_v1_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_v1_router.include_router(organizations.router, prefix="/organizations", tags=["organizations"])
api_v1_router.include_router(farms.router, tags=["farms"])
api_v1_router.include_router(invitations.router, tags=["invitations"])
api_v1_router.include_router(role_assignments.router, tags=["role-assignments"])
api_v1_router.include_router(audit.router, tags=["audit"])
api_v1_router.include_router(production.router, tags=["production"])
