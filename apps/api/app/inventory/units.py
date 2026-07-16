"""Unit conversion for Sprint 4 inventory.

Sprint 4 uses a controlled, closed set of units (:class:`StockUnit`).
Conversion is deliberately narrow:

* Mass dimension: ``kg`` ↔ ``g``  (1 kg = 1000 g)
* Volume dimension: ``L`` ↔ ``mL`` (1 L = 1000 mL)
* Count-like units (``count``, ``bag``, ``pack``) NEVER convert. A
  bag of one item is not a bag of another; forcing a numeric bridge
  would silently corrupt inventory arithmetic.

Any cross-dimension conversion (mass ↔ volume ↔ count) is refused
with :exc:`UnitIncompatibleError`. Callers must catch this at the
service boundary and translate into a 409 with a stable error code.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Final

from app.models.inventory import StockUnit


class UnitIncompatibleError(ValueError):
    """Raised when two units cannot be converted between each other."""

    def __init__(self, source: StockUnit, target: StockUnit) -> None:
        super().__init__(
            f"Cannot convert {source.value!r} to {target.value!r}: incompatible units."
        )
        self.source = source
        self.target = target


# --------------------------------------------------------------------- #
# Base-unit factors — each unit converts to the *canonical base of its
# dimension* by multiplying by the value below. The base for mass is
# ``g``; the base for volume is ``mL``. Same-unit conversions are the
# identity.
# --------------------------------------------------------------------- #
_MASS_TO_G: Final[dict[StockUnit, Decimal]] = {
    StockUnit.KG: Decimal(1000),
    StockUnit.G: Decimal(1),
}

_VOLUME_TO_ML: Final[dict[StockUnit, Decimal]] = {
    StockUnit.L: Decimal(1000),
    StockUnit.ML: Decimal(1),
}

_COUNT_LIKE: Final[frozenset[StockUnit]] = frozenset(
    {StockUnit.COUNT, StockUnit.BAG, StockUnit.PACK}
)


def _dimension(unit: StockUnit) -> str:
    if unit in _MASS_TO_G:
        return "mass"
    if unit in _VOLUME_TO_ML:
        return "volume"
    if unit in _COUNT_LIKE:
        return f"count:{unit.value}"
    raise UnitIncompatibleError(unit, unit)  # unknown unit — defensive


def is_compatible(a: StockUnit, b: StockUnit) -> bool:
    """Return True iff quantities in ``a`` can be safely converted to ``b``."""
    try:
        return _dimension(a) == _dimension(b)
    except UnitIncompatibleError:
        return False


def convert(qty: Decimal | float, source: StockUnit, target: StockUnit) -> Decimal:
    """Convert ``qty`` from ``source`` to ``target``.

    Uses :class:`decimal.Decimal` throughout — inventory arithmetic
    must be exact. Callers passing ``float`` are coerced through
    ``str`` to avoid binary-float noise.
    """
    if source == target:
        return Decimal(str(qty))

    if not is_compatible(source, target):
        raise UnitIncompatibleError(source, target)

    q = Decimal(str(qty))
    if source in _MASS_TO_G:
        base = q * _MASS_TO_G[source]  # → grams
        return base / _MASS_TO_G[target]
    if source in _VOLUME_TO_ML:
        base = q * _VOLUME_TO_ML[source]  # → millilitres
        return base / _VOLUME_TO_ML[target]
    # count-like: only same-unit passes (checked above via is_compatible).
    return q


__all__ = ["UnitIncompatibleError", "convert", "is_compatible"]
