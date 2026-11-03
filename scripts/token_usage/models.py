from collections.abc import Iterable
from dataclasses import dataclass

STAGE_NAMES = ("analyzer", "mitigator", "verifier", "single-agent")


@dataclass(frozen=True)
class StageUsage:
    stage: str
    model_id: str
    input_tokens: int | None
    output_tokens: int | None
    total_tokens: int | None
    cache_read_input_tokens: int | None
    cache_creation_input_tokens: int | None
    reasoning_tokens: int | None
    ai_message_count: int
    ai_messages_with_usage_count: int
    model_call_count: int = 0
    model_calls_with_usage_count: int = 0
    usage_source: str = "trajectory"
    usage_complete: bool = False

    @property
    def uncached_input_tokens(self) -> int | None:
        if (
            self.input_tokens is None
            or self.cache_read_input_tokens is None
            or self.cache_creation_input_tokens is None
        ):
            return None
        return (
            self.input_tokens
            - self.cache_read_input_tokens
            - self.cache_creation_input_tokens
        )

    @property
    def cache_ratio(self) -> float | None:
        if self.input_tokens is None or self.cache_read_input_tokens is None:
            return None
        return (
            self.cache_read_input_tokens / self.input_tokens
            if self.input_tokens > 0
            else 0.0
        )


@dataclass(frozen=True)
class AttemptUsage:
    stage: str
    attempt_label: str
    usage: StageUsage


@dataclass(frozen=True)
class UsageTotals:
    input_tokens: int | None
    output_tokens: int | None
    total_tokens: int | None
    cache_read_input_tokens: int | None
    cache_creation_input_tokens: int | None
    reasoning_tokens: int | None
    ai_message_count: int
    ai_messages_with_usage_count: int
    model_call_count: int = 0
    model_calls_with_usage_count: int = 0
    usage_source: str = "trajectory"
    usage_complete: bool = False

    @property
    def uncached_input_tokens(self) -> int | None:
        if (
            self.input_tokens is None
            or self.cache_read_input_tokens is None
            or self.cache_creation_input_tokens is None
        ):
            return None
        return (
            self.input_tokens
            - self.cache_read_input_tokens
            - self.cache_creation_input_tokens
        )

    @property
    def cache_ratio(self) -> float | None:
        if self.input_tokens is None or self.cache_read_input_tokens is None:
            return None
        return (
            self.cache_read_input_tokens / self.input_tokens
            if self.input_tokens > 0
            else 0.0
        )


def _sum_reported(items: list[StageUsage], field: str) -> int | None:
    values = [getattr(item, field) for item in items]
    return (
        sum(values) if values and all(value is not None for value in values) else None
    )


def aggregate_stage_usages(stages: Iterable[StageUsage]) -> UsageTotals:
    items = list(stages)
    return UsageTotals(
        input_tokens=_sum_reported(items, "input_tokens"),
        output_tokens=_sum_reported(items, "output_tokens"),
        total_tokens=_sum_reported(items, "total_tokens"),
        cache_read_input_tokens=_sum_reported(items, "cache_read_input_tokens"),
        cache_creation_input_tokens=_sum_reported(items, "cache_creation_input_tokens"),
        reasoning_tokens=_sum_reported(items, "reasoning_tokens"),
        model_call_count=sum(item.model_call_count for item in items),
        model_calls_with_usage_count=sum(
            item.model_calls_with_usage_count for item in items
        ),
        usage_source=(
            items[0].usage_source
            if items and len({item.usage_source for item in items}) == 1
            else "mixed"
        ),
        usage_complete=bool(items) and all(item.usage_complete for item in items),
        ai_message_count=sum(item.ai_message_count for item in items),
        ai_messages_with_usage_count=sum(
            item.ai_messages_with_usage_count for item in items
        ),
    )


@dataclass(frozen=True)
class RunUsage:
    run_dir: str
    experiment: str | None
    workflow_kind: str | None
    retry_count_used: int | None
    stages: list[StageUsage]
    attempts: list[AttemptUsage]

    @property
    def totals(self) -> UsageTotals:
        return aggregate_stage_usages(self.stages)

    @property
    def input_tokens(self) -> int | None:
        return self.totals.input_tokens

    @property
    def output_tokens(self) -> int | None:
        return self.totals.output_tokens

    @property
    def total_tokens(self) -> int | None:
        return self.totals.total_tokens

    @property
    def cache_read_input_tokens(self) -> int | None:
        return self.totals.cache_read_input_tokens

    @property
    def uncached_input_tokens(self) -> int | None:
        return self.totals.uncached_input_tokens

    @property
    def cache_ratio(self) -> float | None:
        return self.totals.cache_ratio

    @property
    def ai_message_count(self) -> int:
        return self.totals.ai_message_count

    @property
    def ai_messages_with_usage_count(self) -> int:
        return self.totals.ai_messages_with_usage_count


@dataclass(frozen=True)
class EffectivePatchUsage:
    included_attempts: list[AttemptUsage]

    @property
    def stages(self) -> list[StageUsage]:
        return [item.usage for item in self.included_attempts]

    @property
    def totals(self) -> UsageTotals:
        return aggregate_stage_usages(item.usage for item in self.included_attempts)
