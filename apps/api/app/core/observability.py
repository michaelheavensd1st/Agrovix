"""Observability abstractions.

Provides a stable ``Tracer`` protocol backed by a no-op implementation
today, and a hook to swap in an OpenTelemetry-powered implementation
once the platform is ready to fully instrument traces.

Business code should depend on ``get_tracer()`` — never on OTel directly.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any, Protocol


class Span(Protocol):
    def set_attribute(self, key: str, value: Any) -> None: ...
    def record_exception(self, exc: BaseException) -> None: ...


class Tracer(Protocol):
    @contextmanager
    def start_span(self, name: str, **attrs: Any) -> Iterator[Span]: ...


# --------------------------------------------------------------------- #
# No-op default
# --------------------------------------------------------------------- #
class _NoopSpan:
    def set_attribute(self, key: str, value: Any) -> None:
        return None

    def record_exception(self, exc: BaseException) -> None:
        return None


class _NoopTracer:
    @contextmanager
    def start_span(self, name: str, **attrs: Any) -> Iterator[Span]:
        del name, attrs
        yield _NoopSpan()


_tracer: Tracer = _NoopTracer()


def get_tracer() -> Tracer:
    """Return the currently configured tracer (no-op by default)."""
    return _tracer


def set_tracer(tracer: Tracer) -> None:
    """Install a custom tracer implementation (e.g. OpenTelemetry)."""
    global _tracer
    _tracer = tracer
