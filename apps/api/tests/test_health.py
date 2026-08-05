"""Sanity tests for the health/version endpoints."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.api.v1.endpoints import health as health_endpoint
from app.db.session import get_db_session


async def readiness_response():
    class HealthyDatabase:
        async def execute(self, _statement: object) -> None:
            return None

    app = FastAPI()
    app.include_router(health_endpoint.router, prefix="/api/v1/health")

    async def database_override():
        yield HealthyDatabase()

    app.dependency_overrides[get_db_session] = database_override
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.get("/api/v1/health/ready")


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
    body = r.json()
    assert body["status"] == "ok"
    # Rate-limiter health block should be reported alongside overall status.
    assert body["rate_limiter"]["healthy"] is True
    assert "backend" in body["rate_limiter"]


@pytest.mark.asyncio
async def test_version(client: AsyncClient) -> None:
    r = await client.get("/version")
    assert r.status_code == 200
    assert r.json()["api_prefix"].startswith("/api")


@pytest.mark.asyncio
async def test_readiness_contract_reports_degraded_with_http_200(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class UnhealthyRedis:
        async def ping(self) -> bool:
            raise ConnectionError("controlled readiness failure")

        async def close(self) -> None:
            return None

    redis_client = UnhealthyRedis()
    monkeypatch.setattr(health_endpoint.redis, "from_url", lambda _: redis_client)

    r = await readiness_response()
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "degraded"
    assert body["checks"]["database"] is True
    assert body["checks"]["redis"] is False


@pytest.mark.asyncio
async def test_readiness_contract_reports_ready_with_http_200(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class HealthyRedis:
        async def ping(self) -> bool:
            return True

        async def close(self) -> None:
            return None

    redis_client = HealthyRedis()
    monkeypatch.setattr(health_endpoint.redis, "from_url", lambda _: redis_client)

    r = await readiness_response()
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ready"
    assert body["checks"]["database"] is True
    assert body["checks"]["redis"] is True
