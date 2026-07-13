"""Application logging configuration.

A minimal-but-production-ready logging bootstrap. Structured JSON logging
and OpenTelemetry integrations will be layered on in a later sprint.
"""

from __future__ import annotations

import logging
import sys

from app.core.config import get_settings


def configure_logging() -> None:
    """Configure the root logger for the API process."""
    settings = get_settings()
    level = logging.DEBUG if settings.api_debug else logging.INFO

    formatter = logging.Formatter(
        fmt="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S%z",
    )

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    root = logging.getLogger()
    # Idempotent: replace any pre-existing handlers so ``configure_logging``
    # can safely be called from tests / reloads.
    root.handlers = [handler]
    root.setLevel(level)

    # Tame noisy third-party loggers.
    for noisy in ("uvicorn.access", "sqlalchemy.engine.Engine"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
