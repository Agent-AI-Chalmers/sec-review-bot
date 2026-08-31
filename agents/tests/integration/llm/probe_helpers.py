import os
from collections.abc import Callable
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path

import pytest

from sec_review_agents.utils.package_paths import default_agents_env_path
from tests.integration.llm.deployment_helpers import LLM_TEST_DEPLOYMENT_ENV

_LLM_PROBE_DOTENV_KEYS = {
    "LANGFUSE_BASE_URL",
    "LANGFUSE_PUBLIC_KEY",
    "LANGFUSE_SECRET_KEY",
    "MODEL_PROVIDERS_CONFIG_TOML",
}


def _parse_dotenv_assignment(line: str) -> tuple[str, str] | None:
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None
    if stripped.startswith("export "):
        stripped = stripped[len("export ") :].strip()
    if "=" not in stripped:
        return None
    key, value = stripped.split("=", 1)
    key = key.strip()
    value = value.strip()
    if not key:
        return None
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        value = value[1:-1]
    return key, value


def _load_llm_probe_dotenv() -> None:
    # LLM integration probes should pick up local tracing credentials and model
    # config path overrides without inheriting every application runtime setting.
    dotenv_path = default_agents_env_path()
    if not dotenv_path.is_file():
        return
    for line in dotenv_path.read_text(encoding="utf-8").splitlines():
        assignment = _parse_dotenv_assignment(line)
        if assignment is None:
            continue
        key, value = assignment
        if key in _LLM_PROBE_DOTENV_KEYS and key not in os.environ:
            if key == "MODEL_PROVIDERS_CONFIG_TOML" and value:
                path_value = Path(value).expanduser()
                if not path_value.is_absolute():
                    value = str((dotenv_path.resolve().parent / path_value).resolve())
            os.environ[key] = value


_load_llm_probe_dotenv()


@dataclass(frozen=True)
class ProbeRequirement:
    name: str
    is_met: Callable[[], bool]
    instruction: str


@dataclass(frozen=True)
class LlmProbe:
    run_env: str
    description: str
    requires_deployment: bool = True
    heavy: bool = False
    requirements: tuple[ProbeRequirement, ...] = ()

    @cached_property
    def unmet_requirements(self) -> tuple[ProbeRequirement, ...]:
        return tuple(
            requirement for requirement in self.requirements if not requirement.is_met()
        )

    @cached_property
    def is_enabled(self) -> bool:
        if os.environ.get(self.run_env) != "1":
            return False
        if (
            self.requires_deployment
            and not os.environ.get(LLM_TEST_DEPLOYMENT_ENV, "").strip()
        ):
            return False
        return not self.unmet_requirements

    def enabled(self) -> bool:
        return self.is_enabled

    def skip_reason(self) -> str:
        parts = [f"set {self.run_env}=1"]
        if self.requires_deployment:
            parts.append(f"set {LLM_TEST_DEPLOYMENT_ENV}=<deployment name>")
        parts.extend(
            f"{requirement.name}: {requirement.instruction}"
            for requirement in self.unmet_requirements
        )
        if self.heavy:
            parts.append("this is a heavy real-LLM probe")
        return f"{self.description}: " + "; ".join(parts)

    def skip_unless(self):
        return pytest.mark.skipif(not self.enabled(), reason=self.skip_reason())


def llm_probe(
    *,
    run_env: str,
    description: str,
    requires_deployment: bool = True,
    heavy: bool = False,
    requirements: tuple[ProbeRequirement, ...] = (),
) -> LlmProbe:
    return LlmProbe(
        run_env=run_env,
        description=description,
        requires_deployment=requires_deployment,
        heavy=heavy,
        requirements=requirements,
    )
