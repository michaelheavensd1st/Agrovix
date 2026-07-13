"""Agrovix AgOS — Pod live-preview shim.

╔══════════════════════════════════════════════════════════════════════╗
║  ⚠️  PREVIEW SHIM — NOT CANONICAL, NOT DEPLOYED.                     ║
║                                                                       ║
║  This file exists ONLY so the Emergent pod URL renders something     ║
║  during Sprint reviews. The canonical Postgres-backed backend lives  ║
║  in ``apps/api/``.                                                    ║
║                                                                       ║
║  * Do NOT import from this file anywhere.                             ║
║  * Do NOT add business logic here — Sprint 1+ features live in       ║
║    ``apps/api``.                                                      ║
║  * The Sprint 1 changes (httpOnly cookies, email verification,       ║
║    tenancy, RBAC) are NOT reflected here — this shim only mirrors    ║
║    the Sprint 0 endpoint surface.                                     ║
║  * See ``/app/PREVIEW_SHIM.md`` for the full policy.                  ║
╚══════════════════════════════════════════════════════════════════════╝
"""

from __future__ import annotations

import hashlib
import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv
from fastapi import APIRouter, FastAPI, HTTPException, Request, status
from motor.motor_asyncio import AsyncIOMotorClient
from passlib.context import CryptContext
from pydantic import BaseModel, EmailStr, Field
from starlette.middleware.cors import CORSMiddleware

# --------------------------------------------------------------------------- #
# Env
# --------------------------------------------------------------------------- #
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

APP_NAME = "Agrovix AgOS API (pod shim)"
APP_VERSION = "0.1.0"
APP_ENV = os.environ.get("APP_ENV", "development")
API_V1_PREFIX = "/api/v1"

# Keep the MongoDB client alive for shutdown symmetry with the platform
# defaults, even though the shim does not persist auth data there.
mongo_url = os.environ["MONGO_URL"]
mongo_client = AsyncIOMotorClient(mongo_url)
mongo_db = mongo_client[os.environ["DB_NAME"]]

pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
JWT_SECRET = os.environ.get("JWT_SECRET_KEY", "pod-shim-dev-secret")

# --------------------------------------------------------------------------- #
# In-memory store — the pod shim intentionally avoids a Postgres dependency.
# --------------------------------------------------------------------------- #
_users: dict[str, dict] = {}          # email -> user dict
_refresh_tokens: dict[str, dict] = {} # sha256(token) -> record


# --------------------------------------------------------------------------- #
# Schemas
# --------------------------------------------------------------------------- #
class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    full_name: str | None = None


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=10)


class LogoutRequest(BaseModel):
    refresh_token: str = Field(min_length=10)


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int


class UserPublic(BaseModel):
    id: str
    email: EmailStr
    full_name: str | None = None
    is_active: bool
    is_verified: bool
    is_superuser: bool
    roles: list[str] = []
    created_at: datetime
    updated_at: datetime


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _now() -> datetime:
    return datetime.now(timezone.utc)


def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _make_token() -> str:
    # High-entropy random string — the canonical API issues **signed,
    # structured JWTs backed by a server-side hashed record**; this pod
    # shim uses a simple random URL-safe token instead to avoid dragging
    # JWT signing config into the preview path.
    return secrets.token_urlsafe(48)


def _make_user_record(*, email: str, password: str, full_name: str | None) -> dict:
    now = _now()
    return {
        "id": str(uuid.uuid4()),
        "email": email.lower(),
        "hashed_password": pwd_ctx.hash(password),
        "full_name": full_name,
        "is_active": True,
        "is_verified": False,
        "is_superuser": False,
        "roles": [],
        "created_at": now,
        "updated_at": now,
    }


def _public_user(record: dict) -> UserPublic:
    return UserPublic(**{k: v for k, v in record.items() if k != "hashed_password"})


def _issue_pair(user_id: str) -> TokenPair:
    access = _make_token()
    refresh = _make_token()
    access_exp = _now() + timedelta(minutes=15)
    refresh_exp = _now() + timedelta(days=30)
    _refresh_tokens[_hash_token(refresh)] = {
        "user_id": user_id,
        "expires_at": refresh_exp,
        "revoked": False,
    }
    return TokenPair(
        access_token=access,
        refresh_token=refresh,
        expires_in=int((access_exp - _now()).total_seconds()),
    )


# --------------------------------------------------------------------------- #
# App
# --------------------------------------------------------------------------- #
app = FastAPI(title=APP_NAME, version=APP_VERSION)

_cors_origins = [o.strip() for o in os.environ.get("CORS_ORIGINS", "*").split(",") if o.strip()]
# CORS spec: allow_credentials=True cannot be combined with allow_origins=["*"].
_allow_credentials = _cors_origins != ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_credentials=_allow_credentials,
    allow_origins=_cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Baseline routes (Sprint 0 spec) --------------------------------------- #
@app.get("/", tags=["meta"])
async def root() -> dict:
    return {
        "service": APP_NAME,
        "version": APP_VERSION,
        "environment": APP_ENV,
        "docs": "/docs",
        "note": "This is the pod preview shim. See apps/api for the real backend.",
    }


@app.get("/health", tags=["meta"])
async def health() -> dict:
    return {"status": "ok"}


@app.get("/version", tags=["meta"])
async def version() -> dict:
    return {
        "name": APP_NAME,
        "version": APP_VERSION,
        "environment": APP_ENV,
        "api_prefix": API_V1_PREFIX,
    }


# --- v1 router ------------------------------------------------------------- #
api_router = APIRouter(prefix="/api")
v1 = APIRouter(prefix="/v1")


@v1.get("/health/", tags=["health"])
async def v1_health() -> dict:
    return {"status": "ok"}


@v1.get("/health/ready", tags=["health"])
async def v1_ready() -> dict:
    # Shim: DB/Redis are not required for the pod preview.
    return {"status": "ready", "checks": {"database": True, "redis": True}}


@v1.get("/version/", tags=["version"])
async def v1_version() -> dict:
    return {
        "name": APP_NAME,
        "version": APP_VERSION,
        "environment": APP_ENV,
        "python": os.environ.get("PYTHON_VERSION", "3.11+"),
        "git_commit": os.environ.get("GIT_COMMIT", "unknown"),
        "build_time": os.environ.get("BUILD_TIME", "unknown"),
    }


# --- Auth scaffold --------------------------------------------------------- #
auth = APIRouter(prefix="/auth", tags=["auth"])


@auth.post("/register", response_model=UserPublic, status_code=status.HTTP_201_CREATED)
async def register(payload: RegisterRequest) -> UserPublic:
    email = payload.email.lower()
    if email in _users:
        raise HTTPException(status_code=409, detail="An account with that email already exists.")
    record = _make_user_record(email=email, password=payload.password, full_name=payload.full_name)
    _users[email] = record
    return _public_user(record)


@auth.post("/login", response_model=TokenPair)
async def login(payload: LoginRequest, request: Request) -> TokenPair:
    del request  # unused in the shim
    email = payload.email.lower()
    record = _users.get(email)
    if record is None or not pwd_ctx.verify(payload.password, record["hashed_password"]):
        raise HTTPException(status_code=401, detail="Invalid email or password.")
    if not record["is_active"]:
        raise HTTPException(status_code=403, detail="This account is disabled.")
    return _issue_pair(record["id"])


@auth.post("/refresh", response_model=TokenPair)
async def refresh(payload: RefreshRequest) -> TokenPair:
    token_hash = _hash_token(payload.refresh_token)
    entry = _refresh_tokens.get(token_hash)
    if entry is None or entry["revoked"] or entry["expires_at"] < _now():
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token.")
    # Rotate
    entry["revoked"] = True
    return _issue_pair(entry["user_id"])


@auth.post("/logout")
async def logout(payload: LogoutRequest) -> dict:
    entry = _refresh_tokens.get(_hash_token(payload.refresh_token))
    if entry is not None:
        entry["revoked"] = True
    return {"message": "Logged out"}


@auth.get("/me")
async def me() -> None:
    # The canonical implementation of /auth/me lives in apps/api and
    # validates the bearer token via JWT + DB lookup. The pod shim does
    # not implement JWT parsing on purpose — surfacing 501 here prevents
    # accidental reliance on the shim's identity resolution.
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail="/auth/me is only implemented in apps/api (Postgres-backed).",
    )


v1.include_router(auth)
api_router.include_router(v1)
app.include_router(api_router)


@app.on_event("shutdown")
async def _shutdown() -> None:
    mongo_client.close()
