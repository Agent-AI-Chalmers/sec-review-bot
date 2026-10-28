#!/usr/bin/env python3
"""Check Markdown prose for likely hard wrapping.

This is a conservative, best-effort heuristic rather than a complete Markdown
parser. It skips code fences, headings, lists, tables, blockquotes, HTML blocks,
and generated/dependency directories. It only reports ordinary prose paragraphs
that look mechanically wrapped. Common Markdown structures should still be
handled consistently so they do not hide or misclassify the rest of a document.

Structural lines are matched with their full block syntax rather than a leading
character, so a prose paragraph that merely *starts* with a structural
character is not mistaken for structure: a sentence beginning with an inline
link (`[text](url) ...`) or emphasis (`*word* ...`) is prose, while a reference
definition (`[label]:`) or a list item (`- item`) is structure. Mistaking prose
for structure drops it from its paragraph and can hide a real wrap.
"""

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

from markdown_check_utils import iter_markdown_files

SKIPPED_FILES = {
    "LICENSE.md",
}
PROSE_BREAK_RE = re.compile(r"[.!?。！？:：;；)]$")
EXPLICIT_LINE_BREAK_RE = re.compile(r"(?: {2,}|\\)$")

# Block-level Markdown that ends a prose paragraph. Each pattern is anchored and
# requires the full structural syntax, so a prose line that merely starts with a
# structural character is not mistaken for structure.
ATX_HEADING_RE = re.compile(r"^#{1,6}(?:\s|$)")
SETEXT_UNDERLINE_RE = re.compile(r"^(?:=+|-+)\s*$")
FENCE_RE = re.compile(r"^(?:`{3,}|~{3,})")
INDENTED_CODE_RE = re.compile(r"^(?: {4}|\t)")
BULLET_RE = re.compile(r"^[-*+]\s+")
ORDERED_LIST_RE = re.compile(r"^\d+[.)]\s+")
LIST_ITEM_RE = re.compile(
    r"^(?P<indent>\s*)(?P<marker>[-*+]|\d+[.)])(?P<spacing>\s+)(?P<text>.+)$"
)
BLOCKQUOTE_RE = re.compile(r"^>")
THEMATIC_BREAK_RE = re.compile(r"^(?:-{3,}|\*{3,}|_{3,})\s*$")
TABLE_ROW_RE = re.compile(r"^\|")
RAW_HTML_START_RE = re.compile(
    r"^<(?P<tag>pre|script|style|textarea)(?:\s|>|$)", re.IGNORECASE
)
HTML_DECLARATION_START_RE = re.compile(r"^<![A-Z]")
HTML_BLOCK_TAG_START_RE = re.compile(
    r"^</?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|/?>|$)",
    re.IGNORECASE,
)
HTML_COMPLETE_TAG_RE = re.compile(
    r"^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[^<>]*)?\s*/?>|</[A-Za-z][A-Za-z0-9-]*\s*>)\s*$"
)
# A reference-style link *definition* (`[label]: url`), not an inline link.
REFERENCE_DEFINITION_RE = re.compile(r"^\[[^\]]+\]:")


@dataclass(frozen=True)
class Finding:
    path: Path
    line: int
    preview: str


@dataclass(frozen=True)
class HtmlBlock:
    """How a CommonMark HTML block ends; ``None`` means the first blank line."""

    end_pattern: re.Pattern[str] | None


def html_block_start(stripped: str, *, paragraph_open: bool) -> HtmlBlock | None:
    """Classify the seven CommonMark HTML block start forms in precedence order."""

    raw = RAW_HTML_START_RE.match(stripped)
    if raw is not None:
        tag = raw.group("tag")
        return HtmlBlock(re.compile(rf"</{re.escape(tag)}\s*>", re.IGNORECASE))
    if stripped.startswith("<!--"):
        return HtmlBlock(re.compile(r"-->"))
    if stripped.startswith("<?"):
        return HtmlBlock(re.compile(r"\?>"))
    if stripped.startswith("<![CDATA["):
        return HtmlBlock(re.compile(r"\]\]>"))
    if HTML_DECLARATION_START_RE.match(stripped) is not None:
        return HtmlBlock(re.compile(r">"))
    if HTML_BLOCK_TAG_START_RE.match(stripped) is not None:
        return HtmlBlock(None)
    if not paragraph_open and HTML_COMPLETE_TAG_RE.match(stripped) is not None:
        return HtmlBlock(None)
    return None


def is_structural_line(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return True
    return (
        ATX_HEADING_RE.match(stripped) is not None
        or INDENTED_CODE_RE.match(line) is not None
        or SETEXT_UNDERLINE_RE.match(stripped) is not None
        or FENCE_RE.match(stripped) is not None
        or BULLET_RE.match(stripped) is not None
        or ORDERED_LIST_RE.match(stripped) is not None
        or BLOCKQUOTE_RE.match(stripped) is not None
        or THEMATIC_BREAK_RE.match(stripped) is not None
        or TABLE_ROW_RE.match(stripped) is not None
        or REFERENCE_DEFINITION_RE.match(stripped) is not None
    )


def scannable_line_mask(lines: list[str]) -> list[bool]:
    """Mark physical lines that may participate in prose wrapping checks.

    Block state is resolved once so paragraph and list-item checks cannot drift
    on what counts as Markdown content. The HTML handling follows CommonMark's
    seven block forms and their three termination modes: a fixed marker, a raw
    closing tag, or the first blank line. Structural single lines are filtered
    later by ``is_structural_line``.
    """

    scannable: list[bool] = []
    in_fence = False
    in_frontmatter = False
    html_end_pattern: re.Pattern[str] | None = None
    in_blank_terminated_html_block = False
    paragraph_open = False

    for index, line in enumerate(lines):
        stripped = line.strip()
        if index == 0 and stripped == "---":
            in_frontmatter = True
            scannable.append(False)
            paragraph_open = False
            continue
        if in_frontmatter:
            scannable.append(False)
            if stripped == "---":
                in_frontmatter = False
            paragraph_open = False
            continue
        if in_fence:
            scannable.append(False)
            if FENCE_RE.match(stripped):
                in_fence = False
            paragraph_open = False
            continue
        if html_end_pattern is not None:
            scannable.append(False)
            if html_end_pattern.search(line) is not None:
                html_end_pattern = None
            paragraph_open = False
            continue
        if in_blank_terminated_html_block:
            scannable.append(False)
            if not stripped:
                in_blank_terminated_html_block = False
            paragraph_open = False
            continue
        html_block = html_block_start(stripped, paragraph_open=paragraph_open)
        if html_block is not None:
            scannable.append(False)
            if html_block.end_pattern is None:
                in_blank_terminated_html_block = True
            elif html_block.end_pattern.search(line) is None:
                html_end_pattern = html_block.end_pattern
            paragraph_open = False
            continue
        if FENCE_RE.match(stripped):
            in_fence = True
            scannable.append(False)
            paragraph_open = False
            continue
        scannable.append(True)
        paragraph_open = bool(stripped) and not is_structural_line(line)

    return scannable


def prose_paragraphs(
    lines: list[str], scannable: list[bool]
) -> list[tuple[int, list[str]]]:
    """Collect contiguous ordinary-prose lines with their first line number."""

    paragraphs: list[tuple[int, list[str]]] = []
    current: list[str] = []
    start_line = 0

    for line_number, (line, can_scan) in enumerate(
        zip(lines, scannable, strict=True), start=1
    ):
        if not can_scan or is_structural_line(line):
            if current:
                paragraphs.append((start_line, current))
                current = []
            continue
        if not current:
            start_line = line_number
        current.append(line)

    if current:
        paragraphs.append((start_line, current))
    return paragraphs


def is_wrapped_leading_line(line: str, *, min_width: int) -> bool:
    """Return whether a line appears to continue onto the next source line."""

    return (
        min_width <= len(line.rstrip())
        and PROSE_BREAK_RE.search(line.rstrip()) is None
        and EXPLICIT_LINE_BREAK_RE.search(line) is None
    )


def likely_hard_wrapped(lines: list[str], *, min_width: int, min_lines: int) -> bool:
    """Detect a paragraph whose non-final lines look mechanically wrapped.

    The final line cannot prove wrapping because it naturally ends the
    paragraph. Sentence-ending punctuation and explicit Markdown line breaks
    make a leading line intentional rather than a mechanical continuation.
    """

    if len(lines) < min_lines:
        return False
    wrapped_lines = [
        is_wrapped_leading_line(line, min_width=min_width) for line in lines[:-1]
    ]
    if len(lines) == min_lines:
        return all(wrapped_lines)
    return sum(wrapped_lines) >= min_lines - 1


def paragraph_findings(
    path: Path,
    lines: list[str],
    scannable: list[bool],
    *,
    min_width: int,
    min_lines: int,
) -> list[Finding]:
    """Return hard-wrapping findings for ordinary prose paragraphs."""

    findings: list[Finding] = []
    for line_number, paragraph in prose_paragraphs(lines, scannable):
        if likely_hard_wrapped(paragraph, min_width=min_width, min_lines=min_lines):
            findings.append(
                Finding(
                    path,
                    line_number,
                    " ".join(line.strip() for line in paragraph)[:120],
                )
            )
    return findings


def list_item_findings(
    path: Path, lines: list[str], scannable: list[bool], *, min_width: int
) -> list[Finding]:
    """Return findings for list text wrapped onto an indented continuation.

    A list marker ends paragraph collection as Markdown structure, so this case
    must be checked separately from ordinary prose paragraphs. Indentation is
    relative to the marker's content column: four additional spaces introduce
    list-contained code, while four absolute spaces may still be prose.
    """

    findings: list[Finding] = []
    for index, line in enumerate(lines[:-1]):
        if not scannable[index] or not scannable[index + 1]:
            continue
        item = LIST_ITEM_RE.match(line)
        if item is None:
            continue
        next_line = lines[index + 1]
        next_stripped = next_line.strip()
        if not next_stripped:
            continue
        if is_structural_line(next_line) and INDENTED_CODE_RE.match(next_line) is None:
            continue
        content_indent = len(
            (
                item.group("indent") + item.group("marker") + item.group("spacing")
            ).expandtabs(4)
        )
        continuation_indent = len(
            next_line[: len(next_line) - len(next_line.lstrip(" \t"))].expandtabs(4)
        )
        if continuation_indent < content_indent:
            continue
        if continuation_indent >= content_indent + 4:
            continue
        item_text = item.group("text")
        if is_wrapped_leading_line(item_text, min_width=min_width):
            findings.append(
                Finding(path, index + 1, f"{item_text} {next_stripped}"[:120])
            )
    return findings


def wrapping_findings(root: Path, *, min_width: int, min_lines: int) -> list[Finding]:
    """Scan maintained Markdown files under ``root`` for hard wrapping."""

    findings: list[Finding] = []
    for markdown_file in iter_markdown_files(root):
        if markdown_file.name in SKIPPED_FILES:
            continue
        path = markdown_file.relative_to(root)
        lines = markdown_file.read_text(encoding="utf-8").splitlines()
        scannable = scannable_line_mask(lines)
        findings.extend(
            paragraph_findings(
                path,
                lines,
                scannable,
                min_width=min_width,
                min_lines=min_lines,
            )
        )
        findings.extend(list_item_findings(path, lines, scannable, min_width=min_width))
    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description="Check Markdown hard wrapping.")
    parser.add_argument(
        "root",
        nargs="?",
        default=Path(__file__).resolve().parents[1],
        type=Path,
        help="repository root to scan",
    )
    parser.add_argument("--min-width", type=int, default=1)
    parser.add_argument("--min-lines", type=int, default=2)
    args = parser.parse_args()

    root = args.root.resolve()
    findings = wrapping_findings(
        root,
        min_width=args.min_width,
        min_lines=args.min_lines,
    )
    if findings:
        print("Likely hard-wrapped Markdown prose:", file=sys.stderr)
        for finding in findings:
            print(
                f"- {finding.path}:{finding.line}: {finding.preview}",
                file=sys.stderr,
            )
        return 1
    print("Markdown prose wrapping ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
