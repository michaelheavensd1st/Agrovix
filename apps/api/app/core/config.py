"""Application settings.

Loaded once via ``get_settings`` (cached) — the FastAPI dependency
container will inject the same instance for the process lifetime.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Environment-driven application settings."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # --- Meta ---
    app_name: str = Field(default="Agrovix AgOS API")
    app_version: str = Field(default="0.1.0")
    app_env: str = Field(default="development")
    api_debug: bool = Field(default=True)

    # --- HTTP ---
    api_host: str = Field(default="0.0.0.0")
    api_port: int = Field(default=8000)
    api_prefix: str = Field(default="/api")
    api_v1_prefix: str = Field(default="/api/v1")
    api_cors_origins: str = Field(default="http://localhost:3000")

    # --- Database ---
    database_url: str = Field(
        default="postgresql+asyncpg://agrovix:agrovix_dev@localhost:5432/agrovix_agos",
    )
    database_url_sync: str = Field(
        default="postgresql+psycopg2://agrovix:agrovix_dev@localhost:5432/agrovix_agos",
    )
    database_pool_size: int = Field(default=10)
    database_max_overflow: int = Field(default=20)
    database_echo: bool = Field(default=False)

    # --- Redis ---
    redis_url: str = Field(default="redis://localhost:6379/0")

    # --- JWT / Security ---
    jwt_secret_key: str = Field(default="change-me-in-production")
    jwt_algorithm: str = Field(default="HS256")
    jwt_access_token_expire_minutes: int = Field(default=15)
    jwt_refresh_token_expire_days: int = Field(default=30)
    jwt_issuer: str = Field(default="agrovix-agos")
    jwt_audience: str = Field(default="agrovix-agos-clients")

    password_min_length: int = Field(default=8)
    bcrypt_rounds: int = Field(default=12)

    @field_validator("api_cors_origins")
    @classmethod
    def _strip_cors(cls, value: str) -> str:
        return value.strip()

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.api_cors_origins.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return self.app_env.lower() in {"production", "prod"}


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return a cached ``Settings`` instance."""
    return Settings()
