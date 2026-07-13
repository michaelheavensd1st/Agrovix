"""Version + v1 meta endpoints."""

from __future__ import annotations

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_v1_version(client: AsyncClient) -> None:
    r = await client.get("/api/v1/version/")
    assert r.status_code == 200
    body = r.json()
    assert "git_commit" in body and "build_time" in body


@pytest.mark.asyncio
async def test_v1_health(client: AsyncClient) -> None:
    r = await client.get("/api/v1/health/")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}
