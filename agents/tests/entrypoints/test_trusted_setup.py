import pytest

from sec_review_agents.entrypoints.trusted_setup import (
    DEFAULT_MAX_STEP_TIMEOUT_SECONDS,
    DEFAULT_STEP_TIMEOUT_SECONDS,
    MAX_STEP_TIMEOUT_ENV,
    TrustedSetupError,
    max_step_timeout_seconds,
    parse_trusted_setup,
)


def test_parses_a_minimal_declaration() -> None:
    setup = parse_trusted_setup("setup:\n  - run: pnpm install --frozen-lockfile\n")
    assert len(setup.steps) == 1
    step = setup.steps[0]
    assert step.run == "pnpm install --frozen-lockfile"
    assert step.working_directory is None
    assert step.env == {}
    assert step.timeout_seconds == DEFAULT_STEP_TIMEOUT_SECONDS


def test_parses_all_allowed_keys() -> None:
    setup = parse_trusted_setup(
        "\n".join(
            [
                "setup:",
                "  - run: uv sync --frozen",
                "    working-directory: apps/github-integration",
                "    env:",
                "      NODE_ENV: development",
                "    timeout_seconds: 120",
            ]
        )
    )
    step = setup.steps[0]
    assert step.run == "uv sync --frozen"
    assert step.working_directory == "apps/github-integration"
    assert step.env == {"NODE_ENV": "development"}
    assert step.timeout_seconds == 120


def test_timeout_is_capped_at_the_global_limit() -> None:
    setup = parse_trusted_setup("setup:\n  - run: x\n    timeout_seconds: 99999\n")
    assert setup.steps[0].timeout_seconds == DEFAULT_MAX_STEP_TIMEOUT_SECONDS


def test_timeout_limit_is_configurable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(MAX_STEP_TIMEOUT_ENV, "100")
    assert max_step_timeout_seconds() == 100
    setup = parse_trusted_setup("setup:\n  - run: x\n    timeout_seconds: 500\n")
    assert setup.steps[0].timeout_seconds == 100


def test_invalid_timeout_limit_falls_back_to_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(MAX_STEP_TIMEOUT_ENV, "not-a-number")
    assert max_step_timeout_seconds() == DEFAULT_MAX_STEP_TIMEOUT_SECONDS


def test_rejects_unknown_top_level_key() -> None:
    with pytest.raises(TrustedSetupError, match="unsupported top-level key"):
        parse_trusted_setup("setup:\n  - run: x\nuses: actions/checkout\n")


def test_rejects_unknown_step_key() -> None:
    with pytest.raises(TrustedSetupError, match="unsupported key"):
        parse_trusted_setup("setup:\n  - run: x\n    uses: actions/checkout\n")


def test_rejects_missing_setup_key() -> None:
    with pytest.raises(TrustedSetupError, match="missing the required 'setup' key"):
        parse_trusted_setup("{}\n")


def test_rejects_uses_shorthand() -> None:
    with pytest.raises(TrustedSetupError, match="unsupported key"):
        parse_trusted_setup("setup:\n  - uses: actions/checkout@v4\n")


def test_rejects_missing_run() -> None:
    with pytest.raises(TrustedSetupError, match="missing the required 'run' key"):
        parse_trusted_setup("setup:\n  - working-directory: apps\n")


def test_rejects_blank_run() -> None:
    with pytest.raises(TrustedSetupError, match="run must be a non-empty string"):
        parse_trusted_setup("setup:\n  - run: '   '\n")


def test_rejects_working_directory_escape() -> None:
    for value in ["/etc", "../outside", "apps/../../etc"]:
        with pytest.raises(TrustedSetupError, match="working-directory"):
            parse_trusted_setup(
                f"setup:\n  - run: x\n    working-directory: '{value}'\n"
            )


def test_rejects_non_string_env_values() -> None:
    with pytest.raises(TrustedSetupError, match="env must map string"):
        parse_trusted_setup("setup:\n  - run: x\n    env:\n      NODE_ENV: 1\n")


def test_rejects_invalid_env_variable_name() -> None:
    with pytest.raises(TrustedSetupError, match="invalid variable name"):
        parse_trusted_setup("setup:\n  - run: x\n    env:\n      'A; rm -rf /': boom\n")


def test_accepts_portable_env_variable_names() -> None:
    setup = parse_trusted_setup("setup:\n  - run: x\n    env:\n      _A1: ok\n")
    assert setup.steps[0].env == {"_A1": "ok"}


@pytest.mark.parametrize("raw", ["false", "123", "on"])
def test_rejects_non_string_run(raw: str) -> None:
    # YAML would parse bare false/123/on/null as non-strings; a run must be a
    # literal command string.
    with pytest.raises(TrustedSetupError, match="run must be a non-empty string"):
        parse_trusted_setup(f"setup:\n  - run: {raw}\n")


def test_rejects_invalid_yaml() -> None:
    with pytest.raises(TrustedSetupError, match="not valid YAML"):
        parse_trusted_setup("setup: [broken\n")


def test_rejects_non_mapping_top_level() -> None:
    with pytest.raises(TrustedSetupError, match="must be a mapping"):
        parse_trusted_setup("- run: x\n")


def test_rejects_boolean_timeout() -> None:
    with pytest.raises(TrustedSetupError, match="timeout_seconds must be an integer"):
        parse_trusted_setup("setup:\n  - run: x\n    timeout_seconds: true\n")
