from pathlib import Path

import pytest
from scripts.checks.translated_doc_headings import pair_failures


def check_pair(tmp_path: Path, english: str, translated: str) -> list[str]:
    (tmp_path / "README.md").write_text(english, encoding="utf-8")
    (tmp_path / "README.zh.md").write_text(translated, encoding="utf-8")
    return pair_failures(tmp_path, "README.md", "README.zh.md")


@pytest.mark.parametrize(
    "translated",
    [
        "",
        "<!-- doc-default: mode; source=other.py -->\n",
        "<!-- doc-default: mode; source=ops.py -->\n" * 2,
    ],
)
def test_fact_markers_must_match_in_content_and_count(tmp_path, translated):
    english = "<!-- doc-default: mode; source=ops.py -->\n"
    assert check_pair(tmp_path, english, translated)


def test_fact_markers_must_remain_in_the_corresponding_section(tmp_path):
    """A matching global set must not hide a marker attached to the wrong section."""
    marker = "<!-- doc-time-sensitive: api; checked=2026-11-10; source=https://example.com -->\n"
    assert check_pair(tmp_path, "# One\n" + marker + "# Two\n", "# 一\n# 二\n" + marker)


def test_marker_formatting_and_translated_prose_are_independent(tmp_path):
    assert not check_pair(
        tmp_path,
        "# Example\n<!-- doc-default: mode; source=ops.py -->\nDefault mode.\n",
        "# 示例\n<!--\n  doc-default: mode; source=ops.py\n-->\n默认模式。\n",
    )


@pytest.mark.parametrize("fence", ["```", "~~~", "````"])
def test_fenced_examples_do_not_define_headings_or_fact_markers(tmp_path, fence):
    english = f"# Example\n{fence}markdown\n# Not a heading\n<!-- doc-default: example -->\n{fence}\n"
    translated = (
        f"# 示例\n{fence}markdown\n# 非标题\n<!-- doc-default: 演示 -->\n{fence}\n"
    )
    assert not check_pair(tmp_path, english, translated)


def test_shorter_embedded_fence_does_not_close_a_longer_fence(tmp_path):
    assert not check_pair(
        tmp_path,
        "# Example\n````markdown\n```\n# Example heading\n````\n",
        "# 示例\n````markdown\n```\n# 演示标题\n````\n",
    )


@pytest.mark.parametrize(
    "translated_command",
    ["", "tool --mode learning", "tool --mode reorganization --limit 2"],
)
def test_missing_or_changed_shell_commands_fail(tmp_path, translated_command):
    assert check_pair(
        tmp_path,
        "# Run\n```bash\ntool --mode reorganization\n```\n",
        f"# 运行\n```sh\n{translated_command}\n```\n",
    )


def test_shell_comments_wrapping_and_block_splitting_can_be_translated(tmp_path):
    assert not check_pair(
        tmp_path,
        '# Run\n```bash\n# English\ntool \\\n  --mode learning # note\nother "#literal"\n```\n',
        "# 运行\n```sh\n# 中文\ntool --mode learning # 说明\n```\n\n```shell\nother '#literal'\n```\n",
    )


@pytest.mark.parametrize("argument", ["'#old'", "url#old", "'old\\\nvalue'"])
def test_hashes_and_quoted_data_remain_part_of_shell_examples(tmp_path, argument):
    assert check_pair(
        tmp_path,
        f"# Run\n```bash\ntool {argument}\n```\n",
        f"# 运行\n```bash\ntool {argument.replace('old', 'new')}\n```\n",
    )


def test_command_boundaries_and_order_are_preserved(tmp_path):
    assert check_pair(
        tmp_path,
        "# Run\n```bash\ncd agents\nuv sync\n```\n",
        "# 运行\n```bash\ncd agents uv sync\n```\n",
    )


def test_commands_cannot_move_between_sections(tmp_path):
    assert check_pair(
        tmp_path,
        "# One\n```sh\nfirst\n```\n# Two\n```sh\nsecond\n```\n",
        "# 一\n```sh\nsecond\n```\n# 二\n```sh\nfirst\n```\n",
    )


def test_numbered_heading_structure_is_still_checked(tmp_path):
    assert check_pair(tmp_path, "## 1. One\n", "### 2. 一\n")


def test_localized_non_shell_examples_are_not_compared(tmp_path):
    assert not check_pair(
        tmp_path,
        '# Payload\n```json\n{"message": "hello"}\n```\n',
        '# 请求体\n```json\n{"message": "你好"}\n```\n',
    )


def test_multiline_quoted_value_is_not_a_command_boundary(tmp_path):
    assert check_pair(
        tmp_path,
        "# Run\n```sh\ntool 'one\ntwo'\n```\n",
        "# 运行\n```sh\ntool one\ntwo\n```\n",
    )


def test_headings_and_markers_inside_ordinary_html_comments_are_ignored(tmp_path):
    assert not check_pair(
        tmp_path,
        "# Example\n<!--\n# Hidden heading\n-->\n",
        "# 示例\n<!--\n## 不显示的标题\n-->\n",
    )


@pytest.mark.parametrize(
    "example",
    [
        "# Example\n```bash\nunterminated\n",
        "# Example\n```bash\ntool 'unterminated\n```\n",
    ],
)
def test_invalid_examples_are_reported_instead_of_silently_omitted(tmp_path, example):
    assert check_pair(tmp_path, example, example)


def test_empty_quoted_argument_is_not_ignored(tmp_path):
    assert check_pair(
        tmp_path,
        '# Run\n```sh\ntool ""\n```\n',
        "# 运行\n```sh\ntool\n```\n",
    )


def test_indented_code_examples_do_not_define_fact_markers(tmp_path):
    assert not check_pair(
        tmp_path,
        "# Example\n\n    <!-- doc-default: example -->\n",
        "# 示例\n\n    <!-- doc-default: 演示 -->\n",
    )


@pytest.mark.parametrize(
    "body, translated",
    [
        ("First.\n\nSecond.\n", "第一。\n"),
        ("```json\n{}\n```\n", ""),
        ("| A | B |\n| --- | --- |\n| x | y |\n", "| 甲 | 乙 |\n| --- | --- |\n"),
        ("> Note.\n", ""),
        ("- One\n- Two\n", "- 一\n"),
    ],
)
def test_missing_content_blocks_are_advisory(tmp_path, body, translated):
    """Counts flag possible omissions without rejecting legitimate translation merges."""
    (tmp_path / "README.md").write_text("# Example\n\n" + body)
    (tmp_path / "README.zh.md").write_text("# 示例\n\n" + translated)
    warnings = []
    assert not pair_failures(tmp_path, "README.md", "README.zh.md", warnings)
    assert len(warnings) == 1
    assert "content block counts differ" in warnings[0]


def test_prose_wrapping_does_not_change_block_counts(tmp_path):
    from scripts.checks.translated_doc_headings import sections

    path = tmp_path / "example.md"
    path.write_text("# Example\n\nFirst line\nsecond line.\n\n> Note\n> continued.\n")
    assert sections(path)[1].blocks == {"paragraph": 1, "blockquote paragraph": 1}


@pytest.mark.parametrize(
    "translated, expected_error",
    [
        ("# 示例\n## 额外章节\n", "different heading counts"),
        ("## 示例\n", "heading structures differ"),
        ("# 示例\n```sh\nunterminated\n", "unclosed code fence"),
    ],
)
def test_structure_errors_suppress_content_comparison(
    tmp_path, translated, expected_error
):
    """Unreliable section alignment must not produce misleading content diagnostics."""
    (tmp_path / "README.md").write_text(
        "# Example\n<!-- doc-default: mode -->\nProse.\n```sh\ntool\n```\n"
    )
    (tmp_path / "README.zh.md").write_text(translated)
    warnings = []
    failures = pair_failures(tmp_path, "README.md", "README.zh.md", warnings)
    assert len(failures) == 1
    assert expected_error in failures[0]
    assert warnings == []
