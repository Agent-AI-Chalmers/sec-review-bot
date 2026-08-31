#!/usr/bin/env python3
"""Check repository-local Markdown links.

This intentionally ignores external URLs, pure anchor links, generated output,
virtual environments, and dependency directories. It is meant to catch broken
relative links after documentation moves such as `docs/contracts` -> `contracts`.
"""

import argparse
import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

from markdown_check_utils import iter_markdown_files

INLINE_LINK_RE = re.compile(r"!?\[[^\]]*]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
REFERENCE_DEF_RE = re.compile(r"^\s*\[[^\]]+]:\s+(\S+)", re.MULTILINE)


def strip_code_fences(markdown: str) -> str:
    return re.sub(r"```.*?```", "", markdown, flags=re.DOTALL)


def local_target(link: str) -> str | None:
    parsed = urlparse(link)
    if parsed.scheme or parsed.netloc:
        return None
    if link.startswith("#") or link.startswith("mailto:"):
        return None
    return unquote(parsed.path)


def markdown_links(markdown: str) -> list[str]:
    body = strip_code_fences(markdown)
    links = [match.group(1) for match in INLINE_LINK_RE.finditer(body)]
    links.extend(match.group(1) for match in REFERENCE_DEF_RE.finditer(body))
    return links


def missing_links(root: Path) -> list[str]:
    failures: list[str] = []
    for markdown_file in iter_markdown_files(root):
        markdown = markdown_file.read_text(encoding="utf-8")
        for link in markdown_links(markdown):
            target = local_target(link)
            if target is None:
                continue
            target_path = (markdown_file.parent / target).resolve()
            try:
                target_path.relative_to(root)
            except ValueError:
                failures.append(
                    f"{markdown_file.relative_to(root)} -> {link} escapes repository"
                )
                continue
            if not target_path.exists():
                failures.append(f"{markdown_file.relative_to(root)} -> {link}")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description="Check local Markdown links.")
    parser.add_argument(
        "root",
        nargs="?",
        default=Path(__file__).resolve().parents[1],
        type=Path,
        help="repository root to scan",
    )
    args = parser.parse_args()

    root = args.root.resolve()
    failures = missing_links(root)
    if failures:
        print("Broken local Markdown links:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1
    print("Markdown local links ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
