"""Small shared helpers: decimal money math and seeded randomness."""
from __future__ import annotations

import random
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Iterable, Sequence, TypeVar

T = TypeVar("T")

CENT = Decimal("0.01")


def D(value) -> Decimal:
    """Build a Decimal from int/str/float without binary-float surprises."""
    if isinstance(value, Decimal):
        return value
    if isinstance(value, float):
        return Decimal(repr(value))
    return Decimal(str(value))


def q2(value) -> Decimal:
    """Round half-up to 2 decimal places (accounting rounding)."""
    return D(value).quantize(CENT, rounding=ROUND_HALF_UP)


def fmt2(value) -> str | None:
    """Plain decimal string with exactly 2 decimals (label format)."""
    if value is None:
        return None
    return f"{q2(value):.2f}"


def fmt_qty(value) -> str | None:
    """Quantity label format: minimal representation ("2", "7.5", "-1")."""
    if value is None:
        return None
    d = D(value).normalize()
    s = format(d, "f")
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s


@dataclass
class Rng:
    """Thin wrapper around random.Random with a few domain helpers."""

    r: random.Random

    @classmethod
    def seeded(cls, *parts) -> "Rng":
        key = "|".join(str(p) for p in parts)
        # stable across processes (no PYTHONHASHSEED dependence)
        h = 0
        for ch in key:
            h = (h * 1_000_003 + ord(ch)) % (2**61 - 1)
        return cls(random.Random(h))

    def choice(self, seq: Sequence[T]) -> T:
        return self.r.choice(seq)

    def choices(self, seq: Sequence[T], weights: Sequence[float]) -> T:
        return self.r.choices(seq, weights=weights, k=1)[0]

    def sample(self, seq: Sequence[T], k: int) -> list[T]:
        return self.r.sample(list(seq), k)

    def randint(self, a: int, b: int) -> int:
        return self.r.randint(a, b)

    def uniform(self, a: float, b: float) -> float:
        return self.r.uniform(a, b)

    def random(self) -> float:
        return self.r.random()

    def chance(self, p: float) -> bool:
        return self.r.random() < p

    def shuffle(self, seq: list) -> None:
        self.r.shuffle(seq)

    def digits(self, n: int) -> str:
        return "".join(str(self.r.randint(0, 9)) for _ in range(n))

    def letters(self, n: int, alphabet: str = "ABCDEFGHJKLMNPQRSTUVWXYZ") -> str:
        return "".join(self.r.choice(alphabet) for _ in range(n))

    def child(self, *parts) -> "Rng":
        return Rng.seeded(self.r.random(), *parts)


def chunks(seq: list[T], n: int) -> Iterable[list[T]]:
    for i in range(0, len(seq), n):
        yield seq[i : i + n]
