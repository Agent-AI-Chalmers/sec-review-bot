"""OpenRouter price source for local token-usage reporting.

Prices come from OpenRouter's public model list, not from a maintained table in
this repository. Model identity is the caller's responsibility: a stage's
``model_id`` must name a model the price source knows, either as a full
``<provider>/<model>`` id or as a bare ``<model>`` whose leaf is unique in the
source. This module never guesses a near match; an unknown model yields no price
and the caller reports it as unknown.

There is deliberately no disk cache: a report must not depend on whatever
happened to be fetched on this machine earlier. Every run resolves the current
prices once, and the report records the models it actually used so the numbers
stay explainable without any external state. A failed fetch simply yields no
price source, and every stage is then reported as unknown cost.
"""

from __future__ import annotations

import http.client
import json
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
DEFAULT_TIMEOUT_SECONDS = 10.0


@dataclass(frozen=True)
class ModelPrice:
    """Per-1M-token prices in the currency the source reports (USD)."""

    input: float | None
    cache_read: float | None
    output: float | None
    currency: str = "USD"


@dataclass(frozen=True)
class PriceIndex:
    """One live snapshot of the price source, never persisted.

    ``fetched_at`` is the UTC instant this snapshot was retrieved. It is the
    only timestamp a report needs: it says how fresh the prices are. The source
    is a single live endpoint, so there is no notion of "a price on some past
    date"; a stale figure cannot be requested, only fetched now or not at all.

    ``prices`` is keyed by the full ``<provider>/<model>`` id, lower-cased. A
    leaf-name index is derived once at construction (see ``__post_init__``) so a
    ``lookup`` never re-scans the table and an ambiguous leaf is decided once,
    explicitly, rather than by a hidden rule inside the lookup call.
    """

    prices: dict[str, ModelPrice]
    fetched_at: str
    # ``<leaf>`` -> the single ``<provider>/<model>`` id that owns it. A leaf
    # shared by two or more entries is deliberately absent, so a bare name that
    # is ambiguous resolves to unknown rather than to an arbitrary provider.
    _leaf_ids: dict[str, str] = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        leaf_ids: dict[str, str] = {}
        ambiguous: set[str] = set()
        for key in self.prices:
            leaf = key.split("/", 1)[-1]
            if leaf in leaf_ids:
                ambiguous.add(leaf)
            else:
                leaf_ids[leaf] = key
        for leaf in ambiguous:
            del leaf_ids[leaf]
        object.__setattr__(self, "_leaf_ids", leaf_ids)

    def lookup(self, model_id: str) -> ModelPrice | None:
        """Return the price for ``model_id`` or ``None`` when it is unknown.

        A full ``<provider>/<model>`` id must match a source entry exactly; an
        unknown prefix is never resolved to some other provider's model. A bare
        ``<model>`` name may match by leaf, but only when exactly one entry
        owns that leaf; an ambiguous or missing name is treated as unknown
        rather than guessed.
        """
        normalized = model_id.strip().lower()
        if not normalized:
            return None
        direct = self.prices.get(normalized)
        if direct is not None:
            return direct
        # Only a bare model name may fall back to leaf matching. A ``/`` means
        # the caller gave a full id, and an unmatched full id is unknown: we do
        # not guess another provider's model that happens to share the leaf.
        if "/" in normalized:
            return None
        leaf_key = self._leaf_ids.get(normalized)
        if leaf_key is None:
            return None
        return self.prices[leaf_key]


def _price_from_entry(entry: dict[str, Any]) -> ModelPrice | None:
    pricing = entry.get("pricing")
    if not isinstance(pricing, dict):
        return None

    def per_million(key: str) -> float | None:
        value = pricing.get(key)
        if value is None:
            return None
        try:
            # OpenRouter reports USD per token as a string. A negative value
            # (OpenRouter uses -1) means the price is unavailable or
            # variable, not a real negative rate.
            per_token = float(value)
        except (TypeError, ValueError):
            return None
        if per_token < 0:
            return None
        return per_token * 1_000_000.0

    input_price = per_million("prompt")
    output_price = per_million("completion")
    if input_price is None and output_price is None:
        return None
    return ModelPrice(
        input=input_price,
        cache_read=per_million("input_cache_read"),
        output=output_price,
    )


def parse_models_payload(payload: Any) -> dict[str, ModelPrice]:
    """Turn an OpenRouter ``/models`` payload into ``{id: ModelPrice}``."""
    if not isinstance(payload, dict):
        return {}
    data = payload.get("data")
    if not isinstance(data, list):
        return {}
    prices: dict[str, ModelPrice] = {}
    for entry in data:
        if not isinstance(entry, dict):
            continue
        model_id = entry.get("id")
        if not isinstance(model_id, str) or not model_id.strip():
            continue
        # Skip alias entries that OpenRouter marks with a leading "~".
        if model_id.startswith("~"):
            continue
        price = _price_from_entry(entry)
        if price is not None:
            prices[model_id.strip().lower()] = price
    return prices


def _fetch_payload(timeout_s: float) -> Any | None:
    request = urllib.request.Request(
        OPENROUTER_MODELS_URL,
        headers={"Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_s) as response:
            return json.loads(response.read().decode("utf-8"))
    except (
        urllib.error.URLError,
        OSError,
        ValueError,
        http.client.HTTPException,
    ):
        return None


def load_price_index(
    *,
    timeout_s: float = DEFAULT_TIMEOUT_SECONDS,
    now: str | None = None,
) -> PriceIndex | None:
    """Fetch the current OpenRouter prices, or ``None`` when unavailable.

    There is no cache and no offline fallback: a report either uses the prices
    fetched right now or reports unknown cost. Never raises for network or
    parse problems. ``now`` lets a deterministic caller pin the ``fetched_at``
    stamp without changing what is fetched.
    """
    payload = _fetch_payload(timeout_s)
    if payload is None:
        return None
    prices = parse_models_payload(payload)
    if not prices:
        return None
    fetched_at = now or datetime.now(UTC).isoformat(timespec="seconds")
    return PriceIndex(prices=prices, fetched_at=fetched_at)
