import argparse
import json
import time
from dataclasses import dataclass
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from sec_review_agents.llm.config import (
    build_chat_deployments,
    resolve_deployment_for_agent,
)
from sec_review_agents.llm.factory import (
    create_chat_model,
    create_chat_model_from_deployment,
)

from scripts.token_usage import usage_from_ai_message


@dataclass(frozen=True)
class RoundStats:
    round_index: int
    latency_ms: float
    extracted_usage: dict[str, int] | None
    usage_metadata: dict[str, Any] | None
    response_metadata: dict[str, Any] | None
    response_preview: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run a tiny multi-turn chat experiment and print raw token usage plus the "
            "normalized cached-token fields parsed by diagnostics.py."
        )
    )
    parser.add_argument(
        "--agent",
        default="repository-analyzer",
        help="Agent name passed to create_chat_model().",
    )
    parser.add_argument(
        "--deployment",
        help="Deployment name from model-providers.toml. Overrides --agent selection when provided.",
    )
    parser.add_argument(
        "--rounds",
        type=int,
        default=3,
        help="Number of user turns to send.",
    )
    parser.add_argument(
        "--prefix-repetitions",
        type=int,
        default=120,
        help="How many repeated lines to include in the stable system prefix.",
    )
    parser.add_argument(
        "--sleep-seconds",
        type=float,
        default=0.0,
        help="Optional delay between rounds.",
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=0.0,
        help="Sampling temperature for the probe model.",
    )
    parser.add_argument(
        "--show-raw",
        action="store_true",
        help="Print full usage_metadata/response_metadata JSON for each round.",
    )
    return parser.parse_args()


def _build_stable_prefix(*, repetitions: int) -> str:
    lines = [
        "You are running a prompt-cache probe.",
        "Always answer in one short sentence.",
        "Keep wording compact and stable.",
        "Acknowledge the round number and include the checksum when requested.",
        "",
        "Stable context block follows. This block is intentionally repetitive to maximize prompt-prefix reuse.",
    ]
    for index in range(max(1, repetitions)):
        lines.append(
            f"Cache probe anchor {index + 1:03d}: "
            "repository=demo-repo finding_class=secret-leak severity=high invariant=preserve-prefix"
        )
    return "\n".join(lines)


def _round_prompt(round_index: int) -> str:
    return (
        f"Round {round_index}: reply with exactly one short sentence that mentions round-{round_index} "
        "and checksum-314159."
    )


def _build_messages(
    *,
    stable_prefix: str,
    transcript: list[BaseMessage],
    round_index: int,
) -> list[BaseMessage]:
    return [
        SystemMessage(content=stable_prefix),
        *transcript,
        HumanMessage(content=_round_prompt(round_index)),
    ]


def _preview_text(message: AIMessage) -> str:
    content = message.content
    if isinstance(content, str):
        return " ".join(content.split())[:160]
    if isinstance(content, list):
        chunks: list[str] = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                text = item.get("text")
                if isinstance(text, str) and text.strip():
                    chunks.append(text.strip())
        return " ".join(chunks)[:160]
    return ""


def _visible_text_only_message(message: AIMessage) -> AIMessage:
    content = message.content
    if isinstance(content, str):
        visible_text = content.strip()
    elif isinstance(content, list):
        visible_chunks: list[str] = []
        for item in content:
            if not isinstance(item, dict):
                continue
            if item.get("type") != "text":
                continue
            text = item.get("text")
            if isinstance(text, str) and text.strip():
                visible_chunks.append(text.strip())
        visible_text = "\n".join(visible_chunks)
    else:
        visible_text = ""

    # Preserve metadata for debugging, but replay only plain visible text to avoid
    # deterministic provider rejections on unsupported assistant content blocks.
    return message.model_copy(update={"content": visible_text})


def _message_to_round_stats(
    *, round_index: int, latency_ms: float, message: AIMessage
) -> RoundStats:
    usage_metadata = getattr(message, "usage_metadata", None)
    response_metadata = getattr(message, "response_metadata", None)
    return RoundStats(
        round_index=round_index,
        latency_ms=latency_ms,
        extracted_usage=usage_from_ai_message(message),
        usage_metadata=usage_metadata if isinstance(usage_metadata, dict) else None,
        response_metadata=(
            response_metadata if isinstance(response_metadata, dict) else None
        ),
        response_preview=_preview_text(message),
    )


def _print_round_stats(stats: RoundStats, *, show_raw: bool) -> None:
    print(f"[round {stats.round_index}] latency_ms={stats.latency_ms:.1f}")
    print(f"  response: {stats.response_preview or '-'}")
    print(
        f"  extracted_usage: {json.dumps(stats.extracted_usage, ensure_ascii=False) if stats.extracted_usage else 'null'}"
    )
    if show_raw:
        print(
            "  usage_metadata: "
            + json.dumps(
                stats.usage_metadata, ensure_ascii=False, indent=2, default=str
            )
            if stats.usage_metadata is not None
            else "  usage_metadata: null"
        )
        print(
            "  response_metadata: "
            + json.dumps(
                stats.response_metadata, ensure_ascii=False, indent=2, default=str
            )
            if stats.response_metadata is not None
            else "  response_metadata: null"
        )
    else:
        print(
            "  raw_cache_fields: "
            + json.dumps(
                _extract_raw_cache_fields(stats), ensure_ascii=False, default=str
            )
        )


def _extract_raw_cache_fields(stats: RoundStats) -> dict[str, Any]:
    usage_cache_read = None
    response_cached_tokens = None

    if isinstance(stats.usage_metadata, dict):
        input_details = stats.usage_metadata.get("input_token_details")
        if isinstance(input_details, dict):
            usage_cache_read = input_details.get("cache_read")

    if isinstance(stats.response_metadata, dict):
        token_usage = stats.response_metadata.get("token_usage")
        if isinstance(token_usage, dict):
            prompt_details = token_usage.get("prompt_tokens_details")
            if isinstance(prompt_details, dict):
                response_cached_tokens = prompt_details.get("cached_tokens")

    return {
        "usage_metadata.input_token_details.cache_read": usage_cache_read,
        "response_metadata.token_usage.prompt_tokens_details.cached_tokens": response_cached_tokens,
    }


def _print_summary(results: list[RoundStats]) -> None:
    total_input = 0
    total_output = 0
    total_cached = 0
    rounds_with_cache = 0

    for item in results:
        usage = item.extracted_usage or {}
        total_input += int(usage.get("input_tokens", 0))
        total_output += int(usage.get("output_tokens", 0))
        cached = int(usage.get("cache_read_tokens", 0))
        total_cached += cached
        if cached > 0:
            rounds_with_cache += 1

    print()
    print("Summary")
    print(f"  rounds: {len(results)}")
    print(f"  rounds_with_cache_read_tokens: {rounds_with_cache}")
    print(f"  summed_input_tokens: {total_input}")
    print(f"  summed_output_tokens: {total_output}")
    print(f"  summed_cache_read_tokens: {total_cached}")


def main() -> None:
    args = parse_args()

    if args.rounds <= 0:
        raise SystemExit("--rounds must be >= 1")

    stable_prefix = _build_stable_prefix(repetitions=args.prefix_repetitions)
    if args.deployment:
        deployment_lookup = {
            item.deployment_name: item for item in build_chat_deployments()
        }
        if args.deployment not in deployment_lookup:
            raise SystemExit(f"Unknown deployment: {args.deployment}")
        deployment = deployment_lookup[args.deployment]
        selected_deployment = deployment.deployment_name
        model = create_chat_model_from_deployment(
            deployment,
            temperature=args.temperature,
        )
    else:
        selected_deployment = resolve_deployment_for_agent(args.agent)
        model = create_chat_model(agent_name=args.agent, temperature=args.temperature)

    print("Cached token probe")
    print(f"  agent: {args.agent}")
    print(f"  selected_deployment: {selected_deployment}")
    print(f"  rounds: {args.rounds}")
    print(f"  prefix_repetitions: {args.prefix_repetitions}")
    print(f"  stable_prefix_chars: {len(stable_prefix)}")
    print()

    transcript: list[BaseMessage] = []
    results: list[RoundStats] = []

    for round_index in range(1, args.rounds + 1):
        messages = _build_messages(
            stable_prefix=stable_prefix,
            transcript=transcript,
            round_index=round_index,
        )
        started = time.perf_counter()
        response = model.invoke(messages)
        latency_ms = (time.perf_counter() - started) * 1000

        if not isinstance(response, AIMessage):
            raise TypeError(
                f"Expected AIMessage from model.invoke(), got {type(response).__name__}"
            )

        stats = _message_to_round_stats(
            round_index=round_index, latency_ms=latency_ms, message=response
        )
        results.append(stats)
        _print_round_stats(stats, show_raw=args.show_raw)

        transcript.extend(
            [
                HumanMessage(content=_round_prompt(round_index)),
                _visible_text_only_message(response),
            ]
        )

        if args.sleep_seconds > 0 and round_index < args.rounds:
            time.sleep(args.sleep_seconds)

    _print_summary(results)


if __name__ == "__main__":
    main()
