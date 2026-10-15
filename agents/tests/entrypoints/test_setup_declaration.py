import pytest

from sec_review_agents.entrypoints.setup_declaration import (
    DEFAULT_MAX_STEP_TIMEOUT_SECONDS,
    DEFAULT_STEP_TIMEOUT_SECONDS,
    MAX_STEP_TIMEOUT_ENV,
    SetupDeclarationError,
    max_step_timeout_seconds,
    parse_setup_declaration,
)


def test_parses_a_minimal_declaration() -> None:
    setup = parse_setup_declaration("setup:\n  - run: pnpm install --frozen-lockfile\n")
    assert len(setup.steps) == 1
    step = setup.steps[0]
    assert step.run == "pnpm install --frozen-lockfile"
    assert step.working_directory is None
    assert step.env == {}
    assert step.timeout_seconds == DEFAULT_STEP_TIMEOUT_SECONDS


def test_parses_all_allowed_keys() -> None:
    setup = parse_setup_declaration(
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
    setup = parse_setup_declaration("setup:\n  - run: x\n    timeout_seconds: 99999\n")
    assert setup.steps[0].timeout_seconds == DEFAULT_MAX_STEP_TIMEOUT_SECONDS


def test_timeout_limit_is_configurable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(MAX_STEP_TIMEOUT_ENV, "100")
    assert max_step_timeout_seconds() == 100
    setup = parse_setup_declaration("setup:\n  - run: x\n    timeout_seconds: 500\n")
    assert setup.steps[0].timeout_seconds == 100


def test_invalid_timeout_limit_falls_back_to_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(MAX_STEP_TIMEOUT_ENV, "not-a-number")
    assert max_step_timeout_seconds() == DEFAULT_MAX_STEP_TIMEOUT_SECONDS


def test_default_timeout_is_also_capped(monkeypatch: pytest.MonkeyPatch) -> None:
    # The cap bounds the *effective* timeout, so an operator who lowers it below
    # the default must still see it enforced on steps that omit `timeout_seconds`.
    monkeypatch.setenv(MAX_STEP_TIMEOUT_ENV, "100")
    setup = parse_setup_declaration("setup:\n  - run: x\n")
    assert setup.steps[0].timeout_seconds == 100


def test_rejects_float_syntax_timeout() -> None:
    for content in (
        "setup:\n  - run: x\n    timeout_seconds: 1.0\n",
        "setup:\n  - run: x\n    timeout_seconds: 1e3\n",
    ):
        with pytest.raises(SetupDeclarationError, match="must be an integer"):
            parse_setup_declaration(content)


def test_rejects_explicit_yaml_tags() -> None:
    # The format is the plain Core schema. Explicit tags are rejected on both
    # sides so the two libraries cannot disagree (`yaml` falls back to the raw
    # string for a mismatched tag such as `!!bool on`, while yamlcore raises).
    for content in (
        "setup:\n  - run: !!bool on\n",
        "setup:\n  - run: !!str npm ci\n",
        "setup:\n  - run: x\n    timeout_seconds: !!int x\n",
        "setup:\n  - run: !!seq [a]\n",
    ):
        with pytest.raises(SetupDeclarationError, match="explicit YAML tag"):
            parse_setup_declaration(content)


def test_malformed_tag_is_a_declaration_error_not_an_internal_error() -> None:
    # `!!bool on` and `!!int x` used to make the loader raise a raw
    # `KeyError`/`ValueError`. That must surface as a `SetupDeclarationError`.
    for content in (
        "setup:\n  - run: !!int ''\n",
        "setup:\n  - run: !!float ''\n",
    ):
        with pytest.raises(SetupDeclarationError):
            parse_setup_declaration(content)


def test_rejects_unknown_top_level_key() -> None:
    with pytest.raises(SetupDeclarationError, match="unsupported top-level key"):
        parse_setup_declaration("setup:\n  - run: x\nuses: actions/checkout\n")


def test_rejects_unknown_step_key() -> None:
    with pytest.raises(SetupDeclarationError, match="unsupported key"):
        parse_setup_declaration("setup:\n  - run: x\n    uses: actions/checkout\n")


def test_rejects_missing_setup_key() -> None:
    with pytest.raises(SetupDeclarationError, match="missing the required 'setup' key"):
        parse_setup_declaration("{}\n")


def test_rejects_mixed_type_unknown_top_level_keys() -> None:
    # A YAML mapping key need not be a string (`1:` parses as an int). Reporting
    # unsupported keys must not depend on their type being homogeneous: a raw
    # `sorted()` over mixed int/str keys raised TypeError, escaping the
    # SetupDeclarationError contract. The integration enforcer rejected the same
    # document, so this also keeps the two enforcers on the same boundary.
    with pytest.raises(SetupDeclarationError, match="unsupported top-level key"):
        parse_setup_declaration("setup:\n  - run: x\n1: a\nfoo: b\n")


def test_rejects_mixed_type_unknown_step_keys() -> None:
    with pytest.raises(SetupDeclarationError, match="unsupported key"):
        parse_setup_declaration("setup:\n  - run: x\n    1: a\n    foo: b\n")


def test_rejects_uses_shorthand() -> None:
    with pytest.raises(SetupDeclarationError, match="unsupported key"):
        parse_setup_declaration("setup:\n  - uses: actions/checkout@v4\n")


def test_rejects_missing_run() -> None:
    with pytest.raises(SetupDeclarationError, match="missing the required 'run' key"):
        parse_setup_declaration("setup:\n  - working-directory: apps\n")


def test_rejects_blank_run() -> None:
    with pytest.raises(SetupDeclarationError, match="run must be a non-empty string"):
        parse_setup_declaration("setup:\n  - run: '   '\n")


def test_rejects_working_directory_escape() -> None:
    for value in ["/etc", "../outside", "apps/../../etc"]:
        with pytest.raises(SetupDeclarationError, match="working-directory"):
            parse_setup_declaration(
                f"setup:\n  - run: x\n    working-directory: '{value}'\n"
            )


def test_rejects_non_string_env_values() -> None:
    with pytest.raises(SetupDeclarationError, match="env must map string"):
        parse_setup_declaration("setup:\n  - run: x\n    env:\n      NODE_ENV: 1\n")


def test_rejects_invalid_env_variable_name() -> None:
    with pytest.raises(SetupDeclarationError, match="invalid variable name"):
        parse_setup_declaration(
            "setup:\n  - run: x\n    env:\n      'A; rm -rf /': boom\n"
        )


def test_accepts_portable_env_variable_names() -> None:
    setup = parse_setup_declaration("setup:\n  - run: x\n    env:\n      _A1: ok\n")
    assert setup.steps[0].env == {"_A1": "ok"}


@pytest.mark.parametrize("raw", ["yes", "on", "off", "no", "y", "n"])
def test_accepts_yaml11_boolean_words_as_env_keys(raw: str) -> None:
    # Under the YAML 1.2 Core schema these are plain strings, so they are valid
    # variable names on both enforcers.
    setup = parse_setup_declaration(f"setup:\n  - run: x\n    env:\n      {raw}: ok\n")
    assert setup.steps[0].env == {raw: "ok"}


@pytest.mark.parametrize("raw", ["true", "false", "123", "null"])
def test_rejects_non_string_env_keys(raw: str) -> None:
    # Real booleans/numbers/null are non-strings in the Core schema too, so an
    # env key still has to be a string.
    with pytest.raises(SetupDeclarationError):
        parse_setup_declaration(f"setup:\n  - run: x\n    env:\n      {raw}: ok\n")


@pytest.mark.parametrize("raw", ["false", "123"])
def test_rejects_non_string_run(raw: str) -> None:
    # Core-schema booleans/numbers are not strings; a run must be a literal
    # command string.
    with pytest.raises(SetupDeclarationError, match="run must be a non-empty string"):
        parse_setup_declaration(f"setup:\n  - run: {raw}\n")


def test_rejects_oversized_declaration() -> None:
    from sec_review_agents.entrypoints.setup_declaration import (
        MAX_SETUP_DECLARATION_BYTES,
    )

    filler = "x" * (MAX_SETUP_DECLARATION_BYTES + 1)
    with pytest.raises(SetupDeclarationError, match="exceeds"):
        parse_setup_declaration(f"setup:\n  - run: {filler}\n")


def test_rejects_invalid_yaml() -> None:
    with pytest.raises(SetupDeclarationError, match="not valid YAML"):
        parse_setup_declaration("setup: [broken\n")


def test_rejects_non_mapping_top_level() -> None:
    with pytest.raises(SetupDeclarationError, match="must be a mapping"):
        parse_setup_declaration("- run: x\n")


def test_rejects_boolean_timeout() -> None:
    with pytest.raises(
        SetupDeclarationError, match="timeout_seconds must be an integer"
    ):
        parse_setup_declaration("setup:\n  - run: x\n    timeout_seconds: true\n")


@pytest.mark.parametrize("raw", ["on", "yes", "off", "no", "y", "n"])
def test_unquoted_yaml11_boolean_words_are_strings_as_run(raw: str) -> None:
    # Both enforcers parse with the YAML 1.2 Core schema, where `on`/`yes`/
    # `off`/`no`/`y`/`n` are plain strings, so `run: on` is the command string
    # "on" -- not a boolean. The shared corpus pins this
    # (`valid-yaml12-word-strings.yml`). See the SPEC's dialect section.
    setup = parse_setup_declaration(f"setup:\n  - run: {raw}\n")
    assert setup.steps[0].run == raw
