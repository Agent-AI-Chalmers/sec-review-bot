from sec_review_agents.utils.markdown import (
    inline_code,
    md,
    render_template,
)


def test_render_template_preserves_static_text_and_interpolations() -> None:
    name = "repository"
    count = 3

    assert render_template(t"Review {name}: {count:02d} findings") == (
        "Review repository: 03 findings"
    )


def test_render_template_honors_conversion() -> None:
    value = "quoted"

    assert render_template(t"Value: {value!r}") == "Value: 'quoted'"


def test_render_template_accepts_custom_formatter() -> None:
    finding = "SQL injection"

    assert render_template(t"- {finding}", formatter=lambda value: f"**{value}**") == (
        "- **SQL injection**"
    )


def test_md_escapes_interpolated_backticks_only() -> None:
    field = "user`name"

    assert md(t"- `field`: `{field}`") == ("- `field`: `user\\`name`")


def test_md_escapes_link_text_interpolations() -> None:
    title = "unsafe `preview` route"

    assert (
        md(t"[{title}](./preview.md)") == "[unsafe \\`preview\\` route](./preview.md)"
    )


def test_md_escapes_html_summary_interpolations() -> None:
    summary = "case `one`"

    assert md(t"<summary>{summary}</summary>") == ("<summary>case \\`one\\`</summary>")


def test_md_does_not_escape_static_markdown_fragments() -> None:
    value = "literal"

    assert md(t"**{value}**") == "**literal**"


def test_render_template_honors_ascii_conversion() -> None:
    value = "é"

    assert render_template(t"{value!a}") == "'\\xe9'"


def test_inline_code_formats_short_values() -> None:
    assert inline_code("src/app.py") == "`src/app.py`"


def test_inline_code_escapes_backticks() -> None:
    assert inline_code("user`name") == "`user\\`name`"


def test_inline_code_compacts_whitespace() -> None:
    assert inline_code("  first\nsecond\tthird  ") == "`first second third`"


def test_inline_code_uses_fallback_for_non_text_values() -> None:
    assert inline_code(None, "unknown") == "`unknown`"


def test_inline_code_returns_empty_string_without_value_or_fallback() -> None:
    assert inline_code(None) == ""
