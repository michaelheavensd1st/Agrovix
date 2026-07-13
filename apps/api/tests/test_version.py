"""Version endpoint tests."""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_version_endpoint_returns_metadata(client: TestClient) -> None:
    resp = client.get("/version")
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"]
    assert body["version"]
    assert body["environment"]
    assert body["api_prefix"].startswith("/api")


def test_version_v1_endpoint_returns_metadata(client: TestClient) -> None:
    resp = client.get("/api/v1/version/")
    assert resp.status_code == 200
    body = resp.json()
    assert "git_commit" in body
    assert "build_time" in body
