"""Baseline health-endpoint tests."""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_root_returns_service_banner(client: TestClient) -> None:
    resp = client.get("/")
    assert resp.status_code == 200
    body = resp.json()
    assert body["service"]
    assert body["version"]
    assert body["environment"]


def test_health_endpoint_is_ok(client: TestClient) -> None:
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
