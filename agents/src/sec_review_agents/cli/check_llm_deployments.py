import argparse

from sec_review_agents.llm.config import (
    get_llm_config_for_deployment_check,
    resolve_config_toml_path,
)
from sec_review_agents.llm.deployment_checks import check_deployment
from sec_review_agents.runtime.agent_names import RUNNABLE_AGENT_NAMES
from sec_review_agents.utils.env import bootstrap_agents_env


def _format_duration_ms(duration_seconds: float) -> str:
    return f"{duration_seconds * 1000:8.1f}ms"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Preflight-check every [[deployments]] entry from MODEL_PROVIDERS_CONFIG_TOML by sending a minimal "
            "chat request via the configured LangChain chat deployment + create_agent(response_format=...) and printing "
            "OK/FAIL + latency + error."
        )
    )
    parser.add_argument(
        "--deployment",
        action="append",
        default=[],
        help="Deployment name to check. May be provided multiple times. Defaults to all deployments.",
    )
    parser.add_argument(
        "--fail-fast",
        action="store_true",
        help="Stop immediately after the first failed deployment check.",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=float,
        default=None,
        help="Optional per-request timeout override in seconds. Defaults to each deployment's timeout_ms when set.",
    )
    parser.add_argument(
        "--prompt",
        default="Reply with exactly: ok",
        help="Prompt used for the probe request.",
    )
    parser.add_argument(
        "--structured-prompt",
        default="Return structured output with status=ok and deployment equal to the deployment name.",
        help="Prompt used for the structured-output probe.",
    )
    return parser.parse_args()


def main() -> None:
    bootstrap_agents_env()
    args = parse_args()
    timeout_seconds = args.timeout_seconds

    try:
        llm_config = get_llm_config_for_deployment_check(RUNNABLE_AGENT_NAMES)
    except Exception as error:
        print(f"Failed to load deployment config: {error}")
        raise SystemExit(1)

    deployments = list(llm_config.deployments)

    if args.deployment:
        requested = set(args.deployment)
        deployments = [
            item for item in deployments if item.deployment_name in requested
        ]
        missing = sorted(
            requested.difference({item.deployment_name for item in deployments})
        )
        if missing:
            print(f"Unknown deployment(s): {', '.join(missing)}")
            raise SystemExit(1)

    print(f"CONFIG={resolve_config_toml_path()}")
    print(f"CHAT_DEPLOYMENTS={len(deployments)}")
    print(f"AGENT_DEPLOYMENT_BINDINGS={len(llm_config.agent_deployment_bindings)}")
    print(
        f"TIMEOUT_SECONDS={timeout_seconds if timeout_seconds is not None else 'deployment-config'}"
    )

    checked = 0
    failures = 0
    for index, deployment in enumerate(deployments, start=1):
        checked = index
        result = check_deployment(
            deployment=deployment,
            timeout_seconds=timeout_seconds,
            prompt=args.prompt,
            structured_prompt=args.structured_prompt,
        )
        ping_status = "OK" if result.ping.ok else "FAIL"
        structured_status = "OK" if result.structured.ok else "FAIL"
        base_line = (
            f"[{index}/{len(deployments)}] {result.deployment.deployment_name:<24} "
            f"model={result.deployment.model_id:<32} "
            f"ping={ping_status:<4} ({_format_duration_ms(result.ping.duration_seconds)}) "
            f"structured={structured_status:<4} ({_format_duration_ms(result.structured.duration_seconds)})"
        )
        if result.ping.ok and result.structured.ok:
            print(base_line)
        else:
            failures += 1
            errors: list[str] = []
            if not result.ping.ok and result.ping.error:
                errors.append(f"ping_error={result.ping.error}")
            if not result.structured.ok and result.structured.error:
                errors.append(f"structured_error={result.structured.error}")
            print(f"{base_line} {' '.join(errors)}".strip())
            if args.fail_fast:
                print("fail-fast enabled, stopping after first failure.")
                break

    print(f"SUMMARY checked={checked} ok={checked - failures} failed={failures}")
    if failures > 0:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
