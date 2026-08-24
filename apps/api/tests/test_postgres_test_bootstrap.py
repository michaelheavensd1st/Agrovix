"""Safety regressions for the destructive PostgreSQL test bootstrap."""

from __future__ import annotations

import pytest

from tests.conftest import _validate_disposable_postgres_urls

LOCAL_ASYNC = "postgresql+asyncpg://tester:secret@127.0.0.1:5432/agrovix_validation"
LOCAL_SYNC = "postgresql+psycopg2://tester:secret@127.0.0.1:5432/agrovix_validation"


def test_postgres_reset_guard_accepts_matching_local_validation_database(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("APP_ENV", "test")
    _validate_disposable_postgres_urls(LOCAL_ASYNC, LOCAL_SYNC)


def test_postgres_reset_guard_normalizes_default_port(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APP_ENV", "test")
    _validate_disposable_postgres_urls(
        LOCAL_ASYNC,
        "postgresql+psycopg2://tester:secret@127.0.0.1/agrovix_validation",
    )


@pytest.mark.parametrize(
    ("async_url", "sync_url", "app_env"),
    [
        (LOCAL_ASYNC, LOCAL_SYNC, "production"),
        (
            "postgresql+asyncpg://tester:secret@db.example.com:5432/agrovix_test",
            "postgresql+psycopg2://tester:secret@db.example.com:5432/agrovix_test",
            "test",
        ),
        (
            "postgresql+asyncpg://tester:secret@127.0.0.1:5432/agrovix",
            "postgresql+psycopg2://tester:secret@127.0.0.1:5432/agrovix",
            "test",
        ),
        (
            LOCAL_ASYNC,
            "postgresql+psycopg2://tester:secret@127.0.0.1:5432/other_test",
            "test",
        ),
        (
            LOCAL_ASYNC,
            "postgresql+psycopg2://tester:secret@127.0.0.1:5433/agrovix_validation",
            "test",
        ),
    ],
)
def test_postgres_reset_guard_rejects_unsafe_targets(
    monkeypatch: pytest.MonkeyPatch,
    async_url: str,
    sync_url: str,
    app_env: str,
) -> None:
    monkeypatch.setenv("APP_ENV", app_env)
    with pytest.raises(RuntimeError):
        _validate_disposable_postgres_urls(async_url, sync_url)
