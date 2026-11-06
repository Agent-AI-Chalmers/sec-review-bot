import argparse
import contextlib
import io
import logging
import time
from dataclasses import dataclass

from langchain_core.messages import AIMessage, HumanMessage
from sec_review_agents.llm.config import get_llm_config, resolve_deployment_for_agent
from sec_review_agents.llm.factory import (
    create_chat_model_from_deployment,
    resolve_chat_deployment,
)


@dataclass(frozen=True)
class ProbeResult:
    agent: str
    deployment: str
    baseline_ok: bool
    baseline_ms: float
    baseline_error: str | None
    thinking_probe_ok: bool
    thinking_probe_ms: float
    thinking_probe_error: str | None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Probe current agent deployment selection for compatibility with "
            "assistant content blocks of type=thinking."
        )
    )
    parser.add_argument(
        "--agents",
        nargs="+",
        default=None,
        help=(
            "Optional agent names to test (e.g. repository-triager "
            "repository-analyzer repository-delivery-planner). "
            "Defaults to all configured agent_deployment_bindings."
        ),
    )
    parser.add_argument(
        "--timeout-seconds",
        type=float,
        default=None,
        help="Per-request timeout override. Defaults to each deployment's timeout_ms when set.",
    )
    parser.add_argument(
        "--verbose-errors",
        action="store_true",
        help="Show full traceback logs instead of concise summary output.",
    )
    return parser.parse_args()


def _normalize_error(error: Exception) -> str:
    message = str(error).strip() or error.__class__.__name__
    return " ".join(message.splitlines())[:320]


def _invoke_with_log_mode(fn, *, verbose_errors: bool):
    if verbose_errors:
        return fn()
    # Silence noisy third-party traceback output while preserving the
    # summarized error returned by this script.
    sink = io.StringIO()
    with contextlib.redirect_stderr(sink):
        return fn()


def _run_baseline(
    agent: str, *, timeout_seconds: float | None, verbose_errors: bool
) -> tuple[bool, float, str | None]:
    started = time.perf_counter()
    try:
        deployment = resolve_chat_deployment(agent_name=agent)
        model = create_chat_model_from_deployment(
            deployment,
            temperature=0.0,
            timeout_seconds=timeout_seconds,
        )
        _invoke_with_log_mode(
            lambda: model.invoke([HumanMessage(content="Reply with exactly: ok")]),
            verbose_errors=verbose_errors,
        )
        return True, (time.perf_counter() - started) * 1000, None
    except Exception as error:  # noqa: BLE001
        return False, (time.perf_counter() - started) * 1000, _normalize_error(error)


def _run_thinking_probe(
    agent: str, *, timeout_seconds: float | None, verbose_errors: bool
) -> tuple[bool, float, str | None]:
    started = time.perf_counter()
    try:
        deployment = resolve_chat_deployment(agent_name=agent)
        model = create_chat_model_from_deployment(
            deployment,
            temperature=0.0,
            timeout_seconds=timeout_seconds,
        )
        # Simulate a multi-turn history that contains reasoning blocks.
        # If the downstream OpenAI-compatible endpoint rejects these blocks,
        # this call should fail with an "invalid value: thinking" style error.
        _invoke_with_log_mode(
            lambda: model.invoke(
                [
                    HumanMessage(content="You are a concise assistant."),
                    AIMessage(
                        content=[
                            {
                                "type": "thinking",
                                "thinking": "internal chain-of-thought",
                            },
                            {"type": "text", "text": "Previous visible answer."},
                        ]
                    ),
                    HumanMessage(content="Continue and reply with exactly: ok"),
                ]
            ),
            verbose_errors=verbose_errors,
        )
        return True, (time.perf_counter() - started) * 1000, None
    except Exception as error:  # noqa: BLE001
        return False, (time.perf_counter() - started) * 1000, _normalize_error(error)


def _print_result(result: ProbeResult) -> None:
    baseline_state = "OK" if result.baseline_ok else "FAIL"
    thinking_state = "OK" if result.thinking_probe_ok else "FAIL"
    print(f"[agent={result.agent}] deployment={result.deployment}")
    print(
        f"  baseline: {baseline_state} ({result.baseline_ms:.0f} ms)"
        + ("" if result.baseline_ok else f" error={result.baseline_error}")
    )
    print(
        f"  thinking-probe: {thinking_state} ({result.thinking_probe_ms:.0f} ms)"
        + ("" if result.thinking_probe_ok else f" error={result.thinking_probe_error}")
    )


def main() -> None:
    args = parse_args()
    llm_config = get_llm_config()

    timeout_seconds = args.timeout_seconds
    if not args.verbose_errors:
        for logger_name in ("openai", "httpx"):
            logging.getLogger(logger_name).setLevel(logging.CRITICAL)

    if args.agents:
        agents = [str(item).strip() for item in args.agents if str(item).strip()]
    else:
        agents = sorted(llm_config.agent_deployment_bindings.keys())
    if not agents:
        raise SystemExit(
            "No agents selected. Pass --agent or configure agent_deployment_bindings."
        )

    print("Thinking compatibility probe")
    print(f"Agents under test: {', '.join(agents)}")
    print()

    results: list[ProbeResult] = []
    for agent in agents:
        deployment = resolve_deployment_for_agent(agent)
        baseline_ok, baseline_ms, baseline_error = _run_baseline(
            agent,
            timeout_seconds=timeout_seconds,
            verbose_errors=args.verbose_errors,
        )
        thinking_ok, thinking_ms, thinking_error = _run_thinking_probe(
            agent,
            timeout_seconds=timeout_seconds,
            verbose_errors=args.verbose_errors,
        )
        result = ProbeResult(
            agent=agent,
            deployment=deployment,
            baseline_ok=baseline_ok,
            baseline_ms=baseline_ms,
            baseline_error=baseline_error,
            thinking_probe_ok=thinking_ok,
            thinking_probe_ms=thinking_ms,
            thinking_probe_error=thinking_error,
        )
        results.append(result)
        _print_result(result)
        print()

    failures = [
        item
        for item in results
        if (not item.baseline_ok) or (not item.thinking_probe_ok)
    ]
    print("Summary")
    print(f"  total agents: {len(results)}")
    print(f"  agents with any failure: {len(failures)}")
    if failures:
        print("  failing agents:")
        for item in failures:
            print(f"    - {item.agent} (deployment={item.deployment})")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
