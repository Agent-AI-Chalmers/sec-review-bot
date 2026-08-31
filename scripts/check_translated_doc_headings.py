#!/usr/bin/env python3
"""Check English/Chinese Markdown heading structure.

The translated documents may use localized heading text, but heading levels and
numbered section markers must stay aligned so paired docs do not drift into
different structures.
"""

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
NUMBERED_HEADING_RE = re.compile(r"^(\d+(?:\.\d+)*)\.\s+")


@dataclass(frozen=True)
class Heading:
    line: int
    level: int
    number: str | None
    text: str

    @property
    def signature(self) -> tuple[int, str | None]:
        return (self.level, self.number)


def translated_doc_pairs(root: Path) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    for translated_path in translated_doc_paths(root):
        if any(
            part in {".git", "dist", "node_modules"} for part in translated_path.parts
        ):
            continue
        english_path = translated_path.with_name(
            translated_path.name.removesuffix(".zh.md") + ".md"
        )
        if not english_path.is_file():
            pairs.append(
                (
                    str(english_path.relative_to(root)),
                    str(translated_path.relative_to(root)),
                )
            )
            continue
        pairs.append(
            (
                str(english_path.relative_to(root)),
                str(translated_path.relative_to(root)),
            )
        )
    return pairs


def translated_doc_paths(root: Path) -> list[Path]:
    try:
        completed = subprocess.run(
            ["git", "-C", str(root), "ls-files", "*.zh.md"],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return sorted(root.rglob("*.zh.md"))

    return sorted(root / path for path in completed.stdout.splitlines() if path)


def headings(path: Path) -> list[Heading]:
    result: list[Heading] = []
    in_fence = False
    for line_number, line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), 1
    ):
        stripped = line.strip()
        if stripped.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        match = HEADING_RE.match(line)
        if match is None:
            continue
        marker, text = match.groups()
        number_match = NUMBERED_HEADING_RE.match(text)
        result.append(
            Heading(
                line=line_number,
                level=len(marker),
                number=number_match.group(1) if number_match else None,
                text=text,
            )
        )
    return result


def pair_failures(root: Path, english: str, translated: str) -> list[str]:
    english_path = root / english
    translated_path = root / translated
    if not english_path.is_file():
        return [f"{translated} has no English source pair: {english}"]

    english_headings = headings(english_path)
    translated_headings = headings(translated_path)
    failures: list[str] = []

    if len(english_headings) != len(translated_headings):
        failures.append(
            f"{english} and {translated} have different heading counts: "
            f"{len(english_headings)} != {len(translated_headings)}"
        )
        return failures

    for english_heading, translated_heading in zip(
        english_headings, translated_headings
    ):
        if english_heading.signature != translated_heading.signature:
            failures.append(
                f"{english}:{english_heading.line} and {translated}:{translated_heading.line} "
                f"heading structures differ: "
                f"{english_heading.signature} {english_heading.text!r} != "
                f"{translated_heading.signature} {translated_heading.text!r}"
            )
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Check translated Markdown document heading structure."
    )
    parser.add_argument(
        "root",
        nargs="?",
        default=Path(__file__).resolve().parents[1],
        type=Path,
        help="repository root to scan",
    )
    args = parser.parse_args()

    root = args.root.resolve()
    failures: list[str] = []
    for english, translated in translated_doc_pairs(root):
        failures.extend(pair_failures(root, english, translated))

    if failures:
        print("Translated document heading structure drift:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1

    print("Translated document headings ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
