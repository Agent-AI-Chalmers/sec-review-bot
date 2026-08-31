import signal
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from langchain.agents import create_agent
from pydantic import BaseModel

from sec_review_agents.llm.config import ChatDeploymentConfig
from sec_review_agents.llm.factory import (
    create_chat_model_from_deployment,
)


@dataclass(frozen=True)
class ProbeResult:
    ok: bool
    duration_seconds: float
    error: str | None = None


@dataclass(frozen=True)
class DeploymentCheckResult:
    deployment: ChatDeploymentConfig
    ping: ProbeResult
    structured: ProbeResult


class StructuredProbeOutput(BaseModel):
    """
    Minimal structured probe payload for deployment health checks.
    Keep `status` fixed to `ok` and set `deployment` to the deployment name requested by the probe.
    """

    status: Literal["ok"]
    deployment: str


class HardTimeoutError(TimeoutError):
    pass


def run_with_hard_timeout[T](fn: Callable[[], T], timeout_seconds: float | None) -> T:
    if timeout_seconds is None or timeout_seconds <= 0:
        return fn()

    # setitimer is only available on POSIX; if unavailable, fall back to normal call.
    if not hasattr(signal, "setitimer"):
        return fn()

    def timeout_handler(signum, frame):
        raise HardTimeoutError(f"Hard timeout exceeded: {timeout_seconds:.2f}s")

    previous_handler = signal.getsignal(signal.SIGALRM)
    signal.signal(signal.SIGALRM, timeout_handler)
    signal.setitimer(signal.ITIMER_REAL, timeout_seconds)
    try:
        return fn()
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)


def normalize_error(error: Exception) -> str:
    message = str(error).strip() or error.__class__.__name__
    return " ".join(message.splitlines())[:280]


def run_ping_probe(*, model: Any, prompt: str, timeout_seconds: float | None) -> None:
    run_with_hard_timeout(lambda: model.invoke(prompt), timeout_seconds)


def run_structured_probe(
    *,
    model: Any,
    deployment_name: str,
    structured_prompt: str,
    timeout_seconds: float | None,
) -> StructuredProbeOutput:
    agent = create_agent(
        model=model,
        tools=[],
        response_format=StructuredProbeOutput,
        system_prompt=(
            "Return only structured JSON that matches the response schema. "
            "status must be 'ok'. deployment must be the deployment name."
        ),
    )
    result = run_with_hard_timeout(
        lambda: agent.invoke(
            {
                "messages": [
                    {
                        "role": "user",
                        "content": f"{structured_prompt}\nDeployment name: {deployment_name}\njson",
                    }
                ]
            }
        ),
        timeout_seconds,
    )
    parsed = (result or {}).get("structured_response")
    if isinstance(parsed, StructuredProbeOutput):
        return parsed
    if isinstance(parsed, dict):
        return StructuredProbeOutput.model_validate(parsed)
    raise ValueError("agent returned without structured_response")


def check_deployment(
    *,
    deployment: ChatDeploymentConfig,
    timeout_seconds: float | None,
    prompt: str,
    structured_prompt: str,
) -> DeploymentCheckResult:
    effective_timeout_seconds = (
        timeout_seconds
        if timeout_seconds is not None
        else ((deployment.timeout_ms / 1000) if deployment.timeout_ms else None)
    )
    ping_started = time.perf_counter()
    ping_ok = False
    ping_error: str | None = None
    structured_ok = False
    structured_error: str | None = None
    structured_started = 0.0
    try:
        model = create_chat_model_from_deployment(
            deployment,
            temperature=0.0,
            timeout_seconds=effective_timeout_seconds,
        )
        run_ping_probe(
            model=model, prompt=prompt, timeout_seconds=effective_timeout_seconds
        )
        ping_ok = True
    except Exception as error:
        ping_error = normalize_error(error)

    ping_duration_seconds = time.perf_counter() - ping_started

    try:
        structured_started = time.perf_counter()
        model = create_chat_model_from_deployment(
            deployment,
            temperature=0.0,
            timeout_seconds=effective_timeout_seconds,
        )
        parsed = run_structured_probe(
            model=model,
            deployment_name=deployment.deployment_name,
            structured_prompt=structured_prompt,
            timeout_seconds=effective_timeout_seconds,
        )
        if parsed.status == "ok":
            structured_ok = True
        else:
            structured_error = "agent returned without structured_response"
    except Exception as error:
        structured_error = normalize_error(error)

    structured_duration_seconds = (
        time.perf_counter() - structured_started if structured_started else 0.0
    )

    return DeploymentCheckResult(
        deployment=deployment,
        ping=ProbeResult(
            ok=ping_ok,
            duration_seconds=ping_duration_seconds,
            error=ping_error,
        ),
        structured=ProbeResult(
            ok=structured_ok,
            duration_seconds=structured_duration_seconds,
            error=structured_error,
        ),
    )
