"""Shared pytest fixtures.

These fixtures spin up a lightweight version of the app that does *not*
require a live PostgreSQL / Redis for pure-Python unit tests. Integration
tests that need a real database opt-in via the ``integration`` marker.
"""

from __future__ import annotations

import os

# Ensure a deterministic secret + safe defaults *before* any app imports.
os.environ.setdefault("JWT_SECRET_KEY", "unit-test-secret")
os.environ.setdefault("APP_ENV", "test")

import pytest
from fastapi.testclient import TestClient

from app.main import app  # noqa: E402


@pytest.fixture(scope="session")
def client() -> TestClient:
    """A synchronous TestClient bound to the FastAPI app."""
    return TestClient(app)
