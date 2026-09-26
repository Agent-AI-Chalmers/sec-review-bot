#!/usr/bin/env python3
"""Check Markdown prose for likely hard wrapping.

This is intentionally conservative. It skips code fences, headings, lists,
tables, blockquotes, HTML blocks, and generated/dependency directories. It only
reports ordinary prose paragraphs that look wrapped to a fixed column width.
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
ORDERED_LIST_RE = re.compile(r"^\s*\d+[.)]\s+")
HTML_BLOCK_RE = re.compile(r"^\s*</?[A-Za-z][^>]*>\s*$")


@dataclass(frozen=True)
class Finding:
    path: Path
    line: int
    preview: str


def is_structural_line(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return True
    return (
        stripped.startswith(("#", "- ", "* ", "+ ", "> ", "|", "```", "---", "<!--", "["))
        or ORDERED_LIST_RE.match(stripped) is not None
        or HTML_BLOCK_RE.match(stripped) is not None
    )


def prose_paragraphs(markdown: str) -> list[tuple[int, list[str]]]:
    paragraphs: list[tuple[int, list[str]]] = []
    current: list[str] = []
    start_line = 0
    in_fence = False
    in_frontmatter = False

    for line_number, line in enumerate(markdown.splitlines(), start=1):
        stripped = line.strip()
        if line_number == 1 and stripped == "---":
            in_frontmatter = True
            continue
        if in_frontmatter:
            if stripped == "---":
                in_frontmatter = False
            continue
        if stripped.startswith("```"):
            in_fence = not in_fence
            if current:
                paragraphs.append((start_line, current))
                current = []
            continue
        if in_fence or is_structural_line(line):
            if current:
                paragraphs.append((start_line, current))
                current = []
            continue
        if not current:
            start_line = line_number
        current.append(line.rstrip())

    if current:
        paragraphs.append((start_line, current))
    return paragraphs


def likely_hard_wrapped(
    lines: list[str], *, min_width: int, max_width: int, min_lines: int
) -> bool:
    if len(lines) < min_lines:
        return False
    leading_lines = lines[:-1]
    wrapped_widths = [
        min_width <= len(line) <= max_width and not PROSE_BREAK_RE.search(line.rstrip())
        for line in leading_lines
    ]
    if len(lines) == min_lines:
        return all(wrapped_widths)
    return sum(wrapped_widths) >= min_lines - 1


def wrapping_findings(
    root: Path, *, min_width: int, max_width: int, min_lines: int
) -> list[Finding]:
    findings: list[Finding] = []
    for markdown_file in iter_markdown_files(root):
        if markdown_file.name in SKIPPED_FILES:
            continue
        markdown = markdown_file.read_text(encoding="utf-8")
        for line_number, lines in prose_paragraphs(markdown):
            if likely_hard_wrapped(
                lines, min_width=min_width, max_width=max_width, min_lines=min_lines
            ):
                preview = " ".join(line.strip() for line in lines)[:120]
                findings.append(
                    Finding(markdown_file.relative_to(root), line_number, preview)
                )
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
    parser.add_argument("--min-width", type=int, default=72)
    parser.add_argument("--max-width", type=int, default=100)
    parser.add_argument("--min-lines", type=int, default=3)
    args = parser.parse_args()

    root = args.root.resolve()
    findings = wrapping_findings(
        root,
        min_width=args.min_width,
        max_width=args.max_width,
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
