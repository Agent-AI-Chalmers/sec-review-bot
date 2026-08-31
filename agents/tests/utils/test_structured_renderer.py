from sec_review_agents.utils.structured_renderer import (
    StructuredRenderSchema,
    render_structured_markdown,
)


def test_render_structured_markdown_formats_nested_stage_like_payload() -> None:
    payload = {
        "overview": "Patch covers the SQL injection claim.",
        "patch_coverage": "full",
        "base_score": 8.1,
        "changed_files": ["src/app.py", "tests/test_app.py"],
        "verification_findings": [
            "Parameterized query reaches the sink.",
            {"summary": "Regression suite passed.", "path": "tests/test_app.py"},
        ],
        "metrics": {
            "attack_vector": "network",
            "user_interaction": "none",
            "raw": {"debug": "hidden"},
        },
        "empty_notes": [],
        "not_scored_reason": None,
    }

    assert render_structured_markdown(payload) == [
        "Patch covers the SQL injection claim.",
        "",
        "- Base score: `8.1`",
        "",
        "Changed files:",
        "",
        "- `src/app.py`",
        "- `tests/test_app.py`",
        "",
        "Metrics:",
        "",
        "  - Attack vector: `network`",
        "  - User interaction: `none`",
        "- Patch coverage: `full`",
        "",
        "Verification findings:",
        "",
        "- Parameterized query reaches the sink.",
        "- `tests/test_app.py`: Regression suite passed.",
    ]


def test_render_structured_markdown_formats_anonymous_list_of_dicts() -> None:
    payload = {
        "evidence": [
            {
                "file": "src/server.py",
                "line": 42,
                "summary": "Input reaches the query builder.",
            },
            {
                "title": "Sanitizer check",
                "status": "missing",
                "notes": [
                    "No allowlist was found.",
                    "Escaping happens after SQL concat.",
                ],
            },
        ]
    }

    assert render_structured_markdown(payload) == [
        "Evidence:",
        "",
        "- `src/server.py:42`: Input reaches the query builder.",
        "- Sanitizer check",
        "  - Notes:",
        "    - No allowlist was found.",
        "    - Escaping happens after SQL concat.",
        "  - Status: `missing`",
    ]


def test_render_structured_markdown_formats_tuples_as_ordered_lists() -> None:
    assert render_structured_markdown(
        {
            "changed_files": ("src/app.py", "tests/test_app.py"),
            "nested": {"notes": ("First note.", "Second note.")},
        }
    ) == [
        "Changed files:",
        "",
        "- `src/app.py`",
        "- `tests/test_app.py`",
        "",
        "Nested:",
        "",
        "  - Notes:",
        "    - First note.",
        "    - Second note.",
    ]


def test_render_structured_markdown_accepts_lightweight_display_schema() -> None:
    schema = StructuredRenderSchema(
        key_labels={
            "patch_coverage": "Patch coverage",
            "regression_status": "Regression status",
        },
        field_order={
            "patch_coverage": 10,
            "regression_status": 20,
            "verification_findings": 30,
        },
    )

    assert render_structured_markdown(
        {
            "verification_findings": ["Checked SQL injection path."],
            "regression_status": "not-run",
            "patch_coverage": "full",
        },
        schema=schema,
    ) == [
        "- Patch coverage: `full`",
        "- Regression status: `not-run`",
        "",
        "Verification findings:",
        "",
        "- Checked SQL injection path.",
    ]


def test_render_structured_markdown_profiles_keep_prompt_transcripts_visible() -> None:
    payload = {
        "overview": "Context for retry.",
        "transcripts": ["model requested file context"],
        "diagnostics": ["hidden"],
    }

    assert render_structured_markdown(payload, profile="preview") == [
        "Context for retry."
    ]
    assert render_structured_markdown(payload, profile="prompt") == [
        "Context for retry.",
        "",
        "Transcripts:",
        "",
        "- model requested file context",
    ]
