"""Application entry point.

Wires together configuration, CORS, routers, and lifecycle events.
Business logic is intentionally minimal in Sprint 0.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.v1.router import api_v1_router
from app.core.config import get_settings
from app.core.logging import configure_logging
from app.db.session import dispose_engine

configure_logging()
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Startup / shutdown hooks."""
    settings = get_settings()
    logger.info("Starting %s v%s (env=%s)", settings.app_name, settings.app_version, settings.app_env)
    try:
        yield
    finally:
        logger.info("Shutting down %s", settings.app_name)
        await dispose_engine()


def create_app() -> FastAPI:
    """Application factory."""
    settings = get_settings()

    app = FastAPI(
        title=settings.app_name,
        version=settings.app_version,
        debug=settings.api_debug,
        docs_url="/docs" if settings.api_debug else None,
        redoc_url="/redoc" if settings.api_debug else None,
        openapi_url="/openapi.json" if settings.api_debug else None,
        lifespan=lifespan,
    )

    # CORS
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Baseline (unversioned) routes required by Sprint 0
    @app.get("/", tags=["meta"], summary="Service banner")
    async def root() -> dict[str, str]:
        return {
            "service": settings.app_name,
            "version": settings.app_version,
            "environment": settings.app_env,
            "docs": "/docs",
        }

    @app.get("/health", tags=["meta"], summary="Liveness probe")
    async def health() -> JSONResponse:
        # Sprint 0: a shallow liveness check. Deep readiness (DB + Redis)
        # is exposed under /api/v1/health/ready.
        return JSONResponse({"status": "ok"})

    @app.get("/version", tags=["meta"], summary="Version information")
    async def version() -> dict[str, str]:
        return {
            "name": settings.app_name,
            "version": settings.app_version,
            "environment": settings.app_env,
            "api_prefix": settings.api_v1_prefix,
        }

    # Versioned business API
    app.include_router(api_v1_router, prefix=settings.api_v1_prefix)

    return app


app = create_app()
