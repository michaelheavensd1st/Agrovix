"""Sanity tests for the health/version endpoints."""

from __future__ import annotations

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_root(client: AsyncClient) -> None:
    r = await client.get("/")
    assert r.status_code == 200
    body = r.json()
    assert body["service"] and body["version"]


@pytest.mark.asyncio
async def test_health(client: AsyncClient) -> None:
    r = await client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_version(client: AsyncClient) -> None:
    r = await client.get("/version")
    assert r.status_code == 200
    assert r.json()["api_prefix"].startswith("/api")
