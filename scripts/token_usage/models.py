from collections.abc import Iterable
from dataclasses import dataclass

STAGE_NAMES = ("analyzer", "mitigator", "verifier", "single-agent")


@dataclass(frozen=True)
class StageUsage:
    stage: str
    model_id: str
    input_tokens: int
    output_tokens: int
    total_tokens: int
    cache_read_tokens: int
    reasoning_tokens: int
    ai_message_count: int
    ai_messages_with_usage_count: int

    @property
    def uncached_input_tokens(self) -> int:
        return max(self.input_tokens - self.cache_read_tokens, 0)

    @property
    def cache_ratio(self) -> float:
        return (
            self.cache_read_tokens / self.input_tokens if self.input_tokens > 0 else 0.0
        )


@dataclass(frozen=True)
class AttemptUsage:
    stage: str
    attempt_label: str
    usage: StageUsage


@dataclass(frozen=True)
class UsageTotals:
    input_tokens: int
    output_tokens: int
    total_tokens: int
    cache_read_tokens: int
    reasoning_tokens: int
    ai_message_count: int
    ai_messages_with_usage_count: int

    @property
    def uncached_input_tokens(self) -> int:
        return max(self.input_tokens - self.cache_read_tokens, 0)

    @property
    def cache_ratio(self) -> float:
        return (
            self.cache_read_tokens / self.input_tokens if self.input_tokens > 0 else 0.0
        )


def aggregate_stage_usages(stages: Iterable[StageUsage]) -> UsageTotals:
    items = list(stages)
    return UsageTotals(
        input_tokens=sum(item.input_tokens for item in items),
        output_tokens=sum(item.output_tokens for item in items),
        total_tokens=sum(item.total_tokens for item in items),
        cache_read_tokens=sum(item.cache_read_tokens for item in items),
        reasoning_tokens=sum(item.reasoning_tokens for item in items),
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
    def input_tokens(self) -> int:
        return self.totals.input_tokens

    @property
    def output_tokens(self) -> int:
        return self.totals.output_tokens

    @property
    def total_tokens(self) -> int:
        return self.totals.total_tokens

    @property
    def cache_read_tokens(self) -> int:
        return self.totals.cache_read_tokens

    @property
    def uncached_input_tokens(self) -> int:
        return self.totals.uncached_input_tokens

    @property
    def cache_ratio(self) -> float:
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
        return aggregate_stage_usages(self.stages)


@dataclass(frozen=True)
class PricingSelection:
    mode: str
    profile: str | None
    input_rate: float | None
    cache_rate: float | None
    output_rate: float | None
    currency: str | None


@dataclass(frozen=True)
class PricingConfig:
    price_profile: str | None = None
    input_rate: float | None = None
    cache_rate: float | None = None
    output_rate: float | None = None


@dataclass(frozen=True)
class CostEstimate:
    amount: float
    currency: str
