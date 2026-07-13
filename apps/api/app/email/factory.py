"""Email sender factory."""

from __future__ import annotations

from functools import lru_cache

from app.core.config import get_settings
from app.email.base import EmailSender
from app.email.log_sender import LogEmailSender


@lru_cache(maxsize=1)
def get_email_sender() -> EmailSender:
    settings = get_settings()
    provider = settings.email_provider.lower()
    if provider == "log":
        return LogEmailSender()
    # Placeholder — Resend / SendGrid implementations will be added here.
    # Falling back to the log sender keeps the API usable in every env
    # until a real provider is configured.
    return LogEmailSender()
