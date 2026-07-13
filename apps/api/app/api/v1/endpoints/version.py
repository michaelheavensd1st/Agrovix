"""Version endpoint (v1)."""

from __future__ import annotations

import os

from fastapi import APIRouter

from app.core.config import get_settings

router = APIRouter()


@router.get("/", summary="Detailed version metadata")
async def version() -> dict[str, str]:
    settings = get_settings()
    return {
        "name": settings.app_name,
        "version": settings.app_version,
        "environment": settings.app_env,
        "python": os.environ.get("PYTHON_VERSION", "3.12"),
        "git_commit": os.environ.get("GIT_COMMIT", "unknown"),
        "build_time": os.environ.get("BUILD_TIME", "unknown"),
    }
