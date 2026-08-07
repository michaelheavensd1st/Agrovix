"""Backend regression tests for the Agrovix AgOS Sprint 0 pod shim.

Covers:
  * Baseline routes (GET /, /health, /version) — tested via localhost since
    the Kubernetes ingress only routes /api/* to the backend on the public URL.
  * v1 meta routes (/api/v1/health/, /health/ready, /version/).
  * Auth scaffold happy paths + one negative each: register, login, refresh
    rotation, logout revocation.
"""
from __future__ import annotations

import os
import uuid

import pytest
import requests

PUBLIC_URL = os.environ.get(
    "REACT_APP_BACKEND_URL",
    "https://phase-one-launch.preview.emergentagent.com",
).rstrip("/")
LOCAL_URL = "http://localhost:8001"

TIMEOUT = 15


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #
@pytest.fixture(scope="session")
def api_client() -> requests.Session:
    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})
    return session


@pytest.fixture(scope="session")
def fresh_user() -> dict:
    """Unique test account per pytest session."""
    return {
        "email": f"qa+agos-{uuid.uuid4().hex[:10]}@agrovix.dev",
        "password": "SprintZero!2026",
        "full_name": "AgOS QA",
    }


# --------------------------------------------------------------------------- #
# Baseline routes (localhost — ingress only forwards /api/* publicly)
# --------------------------------------------------------------------------- #
class TestBaseline:
    def test_root_banner(self, api_client):
        r = api_client.get(f"{LOCAL_URL}/", timeout=TIMEOUT)
        assert r.status_code == 200
        data = r.json()
        assert "service" in data and "AgOS" in data["service"]
        assert data["version"] == "0.1.0"
        assert data["environment"] == "development"

    def test_health_ok(self, api_client):
        r = api_client.get(f"{LOCAL_URL}/health", timeout=TIMEOUT)
        assert r.status_code == 200
        assert r.json() == {"status": "ok"}

    def test_version_meta(self, api_client):
        r = api_client.get(f"{LOCAL_URL}/version", timeout=TIMEOUT)
        assert r.status_code == 200
        data = r.json()
        for key in ("name", "version", "environment", "api_prefix"):
            assert key in data
        assert data["api_prefix"] == "/api/v1"


# --------------------------------------------------------------------------- #
# v1 meta routes (public URL because they are prefixed with /api)
# --------------------------------------------------------------------------- #
class TestV1Meta:
    def test_v1_health(self, api_client):
        r = api_client.get(f"{PUBLIC_URL}/api/v1/health/", timeout=TIMEOUT)
        assert r.status_code == 200
        assert r.json() == {"status": "ok"}

    def test_v1_ready(self, api_client):
        r = api_client.get(f"{PUBLIC_URL}/api/v1/health/ready", timeout=TIMEOUT)
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "ready"
        assert data["checks"]["database"] is True
        assert data["checks"]["redis"] is True

    def test_v1_version(self, api_client):
        r = api_client.get(f"{PUBLIC_URL}/api/v1/version/", timeout=TIMEOUT)
        assert r.status_code == 200
        data = r.json()
        for key in ("name", "version", "environment", "git_commit", "build_time"):
            assert key in data


# --------------------------------------------------------------------------- #
# Auth scaffold — must run in order (register -> login -> refresh -> logout)
# --------------------------------------------------------------------------- #
_state: dict = {}


class TestAuth:
    def test_01_register_success(self, api_client, fresh_user):
        r = api_client.post(
            f"{PUBLIC_URL}/api/v1/auth/register",
            json=fresh_user,
            timeout=TIMEOUT,
        )
        assert r.status_code == 201, r.text
        data = r.json()
        assert data["email"] == fresh_user["email"].lower()
        assert data["is_active"] is True
        assert data["roles"] == []
        assert "id" in data and isinstance(data["id"], str)
        _state["user_id"] = data["id"]

    def test_02_register_duplicate_conflict(self, api_client, fresh_user):
        r = api_client.post(
            f"{PUBLIC_URL}/api/v1/auth/register",
            json=fresh_user,
            timeout=TIMEOUT,
        )
        assert r.status_code == 409, r.text
        assert "already exists" in r.json()["detail"].lower()

    def test_03_login_success(self, api_client, fresh_user):
        r = api_client.post(
            f"{PUBLIC_URL}/api/v1/auth/login",
            json={"email": fresh_user["email"], "password": fresh_user["password"]},
            timeout=TIMEOUT,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["token_type"] == "bearer"
        assert isinstance(data["access_token"], str) and len(data["access_token"]) > 20
        assert isinstance(data["refresh_token"], str) and len(data["refresh_token"]) > 20
        assert data["expires_in"] > 0
        _state["refresh_token"] = data["refresh_token"]
        _state["access_token"] = data["access_token"]

    def test_04_login_invalid_password(self, api_client, fresh_user):
        r = api_client.post(
            f"{PUBLIC_URL}/api/v1/auth/login",
            json={"email": fresh_user["email"], "password": "WrongPassword!1"},
            timeout=TIMEOUT,
        )
        assert r.status_code == 401
        assert r.json()["detail"] == "Invalid email or password."

    def test_05_refresh_rotation(self, api_client):
        original = _state["refresh_token"]
        r = api_client.post(
            f"{PUBLIC_URL}/api/v1/auth/refresh",
            json={"refresh_token": original},
            timeout=TIMEOUT,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["access_token"] != _state["access_token"]
        assert data["refresh_token"] != original
        _state["refresh_token_v2"] = data["refresh_token"]

        # Old refresh token should be revoked (rotation)
        r2 = api_client.post(
            f"{PUBLIC_URL}/api/v1/auth/refresh",
            json={"refresh_token": original},
            timeout=TIMEOUT,
        )
        assert r2.status_code == 401
        assert "invalid" in r2.json()["detail"].lower() or "expired" in r2.json()["detail"].lower()

    def test_06_logout_revokes_refresh(self, api_client):
        rt = _state["refresh_token_v2"]
        r = api_client.post(
            f"{PUBLIC_URL}/api/v1/auth/logout",
            json={"refresh_token": rt},
            timeout=TIMEOUT,
        )
        assert r.status_code == 200
        assert r.json() == {"message": "Logged out"}

        # Subsequent refresh with logged-out token must fail
        r2 = api_client.post(
            f"{PUBLIC_URL}/api/v1/auth/refresh",
            json={"refresh_token": rt},
            timeout=TIMEOUT,
        )
        assert r2.status_code == 401
