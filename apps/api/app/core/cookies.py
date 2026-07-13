"""Cookie helpers.

Web clients receive their access + refresh tokens as httpOnly, Secure,
SameSite cookies. Access tokens are **never** exposed to JavaScript.
"""

from __future__ import annotations

from fastapi import Response

from app.core.config import get_settings


def _base_kwargs() -> dict:
    s = get_settings()
    return {
        "httponly": True,
        "secure": s.cookie_secure,
        "samesite": s.cookie_samesite,
        "domain": s.cookie_domain,
        "path": "/",
    }


def set_auth_cookies(
    response: Response,
    *,
    access_token: str,
    refresh_token: str,
    access_max_age_s: int,
    refresh_max_age_s: int,
) -> None:
    s = get_settings()
    kw = _base_kwargs()
    response.set_cookie(
        key=s.cookie_access_name,
        value=access_token,
        max_age=access_max_age_s,
        **kw,
    )
    response.set_cookie(
        key=s.cookie_refresh_name,
        value=refresh_token,
        max_age=refresh_max_age_s,
        **kw,
    )


def clear_auth_cookies(response: Response) -> None:
    s = get_settings()
    kw = _base_kwargs()
    response.delete_cookie(s.cookie_access_name, path=kw["path"], domain=kw["domain"])
    response.delete_cookie(s.cookie_refresh_name, path=kw["path"], domain=kw["domain"])
