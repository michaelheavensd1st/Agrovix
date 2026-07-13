"""Auth-related unit tests (pure Python, no DB required)."""

from __future__ import annotations

from uuid import uuid4

import pytest
from jose import JWTError

from app.core.security import (
    TokenInvalidError,
    create_token,
    decode_token,
    hash_password,
    verify_password,
)


def test_hash_and_verify_password_roundtrip() -> None:
    plain = "s3cret-Password!"
    hashed = hash_password(plain)
    assert hashed != plain
    assert verify_password(plain, hashed) is True
    assert verify_password("wrong-password", hashed) is False


def test_create_and_decode_access_token() -> None:
    subject = uuid4()
    token, exp = create_token(subject=subject, token_type="access")
    payload = decode_token(token, expected_type="access")
    assert payload["sub"] == str(subject)
    assert payload["typ"] == "access"
    assert exp is not None


def test_decode_rejects_wrong_token_type() -> None:
    token, _ = create_token(subject=uuid4(), token_type="refresh")
    with pytest.raises(TokenInvalidError):
        decode_token(token, expected_type="access")
