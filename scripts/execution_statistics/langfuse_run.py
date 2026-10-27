from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

from langfuse.api.observations.client import ObservationsClient
from sec_review_agents.runtime.agent_names import REVIEW_AGENT_NAMES

ROOT_FIELDS = "basic,metadata"
GENERATION_FIELDS = "basic,time,metadata,model,usage"
LANGFUSE_SDK_INSTRUMENTATION_SCOPE = "langfuse-sdk"

TOKEN_FIELDS = (
    "input",
    "output",
    "total",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "reasoning",
)


@dataclass(frozen=True)
class ReadResult:
    # Root traces admitted by the maintained review-agent allowlist.
    roots: list[dict[str, Any]]
    # Canonical LangChain model calls emitted by the Langfuse callback.
    generations: list[dict[str, Any]]
    # Same-session roots belonging to memory agents or unknown agent names.
    excluded_non_review_root_count: int


def _read_pages(
    observations: ObservationsClient,
    *,
    limit: int,
    **filters: Any,
) -> list[dict[str, Any]]:
    cursor: str | None = None
    items: list[dict[str, Any]] = []
    while True:
        page = observations.get_many(limit=limit, cursor=cursor, **filters)
        items.extend(item.model_dump(by_alias=True) for item in page.data)
        cursor = page.meta.cursor
        if cursor is None:
            return items


def _metadata(observation: Mapping[str, Any]) -> Mapping[str, Any]:
    value = observation.get("metadata")
    return value if isinstance(value, Mapping) else {}


def _trace_id(observation: Mapping[str, Any]) -> str | None:
    value = observation.get("traceId", observation.get("trace_id"))
    return value if isinstance(value, str) and value else None


def _observation_id(observation: Mapping[str, Any]) -> str | None:
    value = observation.get("id")
    return value if isinstance(value, str) and value else None


def _deduplicate_observations(
    observations: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    for observation in observations:
        observation_id = _observation_id(observation)
        if observation_id is not None:
            by_id[observation_id] = observation
    return list(by_id.values())


def read_run_observations(
    observations: ObservationsClient,
    *,
    run_id: str,
    page_size: int = 100,
) -> ReadResult:
    """Read known review-agent roots, then all generation calls under them."""
    # A run session can also contain later memory work that reuses the same run_id.
    # Start with every root in the session, then admit only known review agents.
    candidate_roots = _deduplicate_observations(
        _read_pages(
            observations,
            limit=page_size,
            fields=ROOT_FIELDS,
            session_id=run_id,
            is_root_observation=True,
        )
    )
    review_roots = [
        root
        for root in candidate_roots
        if _metadata(root).get("sec_review_agent") in REVIEW_AGENT_NAMES
    ]

    generations_by_id: dict[str, dict[str, Any]] = {}
    trace_ids = sorted(
        trace_id for root in review_roots if (trace_id := _trace_id(root)) is not None
    )
    for trace_id in trace_ids:
        for generation in _read_pages(
            observations,
            limit=page_size,
            fields=GENERATION_FIELDS,
            trace_id=trace_id,
            type="GENERATION",
        ):
            observation_id = _observation_id(generation)
            if observation_id is None:
                continue
            # Production suppresses provider-SDK duplicates before export. A different
            # scope here means that invariant regressed, so the probe must fail loudly.
            if (
                _metadata(generation).get("scope.name")
                != LANGFUSE_SDK_INSTRUMENTATION_SCOPE
            ):
                raise RuntimeError(
                    f"Review generation {observation_id} has unexpected instrumentation scope."
                )
            generations_by_id[observation_id] = generation

    return ReadResult(
        roots=review_roots,
        generations=list(generations_by_id.values()),
        excluded_non_review_root_count=len(candidate_roots) - len(review_roots),
    )


def _string_value(value: Any) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def _int_value(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _usage_details(observation: Mapping[str, Any]) -> Mapping[str, Any]:
    value = observation.get("usageDetails", observation.get("usage_details"))
    return value if isinstance(value, Mapping) else {}


def _call_usage(observation: Mapping[str, Any]) -> dict[str, int] | None:
    raw = _usage_details(observation)
    usage = {
        field: number
        for field in TOKEN_FIELDS
        if (number := _int_value(raw.get(field))) is not None
    }
    return usage or None


def _empty_totals() -> dict[str, int]:
    return {field: 0 for field in TOKEN_FIELDS}


def _add_usage(totals: dict[str, int], usage: Mapping[str, int]) -> None:
    for field in TOKEN_FIELDS:
        totals[field] += usage.get(field, 0)


def aggregate_run(
    *,
    run_id: str,
    generations: Iterable[Mapping[str, Any]],
    root_count: int,
    excluded_non_review_root_count: int,
) -> dict[str, Any]:
    """Aggregate only observed generation calls without claiming upload completeness."""
    calls = list(generations)
    totals = _empty_totals()
    usage_reported_call_count = 0
    groups: dict[tuple[str | None, str | None, str | None], dict[str, Any]] = {}

    for call in calls:
        metadata = _metadata(call)
        agent_name = _string_value(metadata.get("sec_review_agent"))
        provider = _string_value(metadata.get("ls_provider"))
        model = _string_value(call.get("model")) or _string_value(
            metadata.get("ls_model_name")
        )
        usage = _call_usage(call)
        if usage is not None:
            usage_reported_call_count += 1
            _add_usage(totals, usage)

        key = (agent_name, provider, model)
        group = groups.setdefault(
            key,
            {
                "agent_name": agent_name,
                "provider": provider,
                "model": model,
                "model_call_count": 0,
                "usage_reported_call_count": 0,
                "token_usage": _empty_totals(),
            },
        )
        group["model_call_count"] += 1
        if usage is not None:
            group["usage_reported_call_count"] += 1
            _add_usage(group["token_usage"], usage)

    observed_call_count = len(calls)
    if observed_call_count == 0:
        coverage = "unavailable"
    elif usage_reported_call_count == observed_call_count:
        coverage = "complete_for_observed_calls"
    else:
        coverage = "partial"

    sorted_groups = sorted(
        groups.values(),
        key=lambda item: (
            item["agent_name"] or "",
            item["provider"] or "",
            item["model"] or "",
        ),
    )
    return {
        "run_id": run_id,
        "root_trace_count": root_count,
        # This explains same-session roots that are intentionally outside review totals.
        "excluded_non_review_root_count": excluded_non_review_root_count,
        "observed_call_count": observed_call_count,
        "usage_reported_call_count": usage_reported_call_count,
        "observed_usage_coverage": coverage,
        "token_usage": totals,
        "groups": sorted_groups,
    }
