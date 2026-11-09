#!/usr/bin/env python3
"""Check translated structure, fact markers, and shell command examples.

Prose and non-shell examples may be localized. Compare machine-readable content
within corresponding heading sections, allowing translated shell comments and
formatting differences. This is a structural check, not a semantic translation
review or a full Markdown/shell parser.
"""

import argparse
import re
import shlex
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
FENCE_RE = re.compile(r"^\s*(`{3,}|~{3,})(.*)$")
SHELL_LANGUAGES = {"bash", "sh", "shell", "zsh"}
FACT_MARKER_RE = re.compile(r"\s*(doc-(?:default|time-sensitive):.*?)\s*", re.DOTALL)
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

    return sorted(
        root / path
        for path in completed.stdout.splitlines()
        if path and not Path(path).name.startswith("TEMP_")
    )


@dataclass
class Section:
    heading: Heading | None = None
    markers: list[str] = field(default_factory=list)
    shell_tokens: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    blocks: Counter[str] = field(default_factory=Counter)

    @property
    def line(self) -> int:
        return self.heading.line if self.heading else 1


def shell_tokens(code: str) -> list[str]:
    """Normalize examples without discarding quoted data or URL fragments."""
    cleaned: list[str] = []
    quote: str | None = None
    word_start = True
    index = 0
    while index < len(code):
        char = code[index]
        if char == "\\" and quote != "'" and index + 1 < len(code):
            following = code[index + 1]
            if following != "\n":
                cleaned.extend((char, following))
                word_start = False
            index += 2
            continue
        if quote is not None:
            cleaned.append(char)
            if char == quote:
                quote = None
        elif char in {"'", '"'}:
            quote = char
            cleaned.append(char)
            word_start = False
        elif char == "#" and word_start:
            end = code.find("\n", index)
            index = end if end >= 0 else len(code)
            continue
        else:
            cleaned.append(char)
            word_start = char.isspace() or char in ";&|()<>"
        index += 1

    lexer = shlex.shlex("".join(cleaned), posix=True, punctuation_chars=";&|()\n")
    lexer.whitespace = " \t\r"
    lexer.whitespace_split = True
    lexer.commenters = ""
    tokens: list[str] = []
    for token in lexer:
        if token == "":
            tokens.append(token)
            continue
        # shlex groups adjacent punctuation, including blank lines. Preserve
        # command boundaries but ignore extra blank lines around comments.
        parts = re.split(r"(\n+)", token) if set(token) <= set(";&|()\n") else [token]
        for part in parts:
            if not part:
                continue
            if set(part) == {"\n"}:
                if tokens and tokens[-1] != "\n":
                    tokens.append("\n")
            else:
                tokens.append(part)
    if tokens and tokens[-1] == "\n":
        tokens.pop()
    return tokens


def sections(path: Path) -> list[Section]:
    result = [Section()]
    fence: tuple[str, str, int] | None = None
    body: list[str] = []
    comment: list[str] | None = None
    paragraph = False
    for line_number, line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), 1
    ):
        section = result[-1]
        stripped = line.strip()
        if not stripped:
            paragraph = False
        if fence is None and comment is None and line.startswith(("    ", "\t")):
            continue
        if comment is not None or (fence is None and stripped.startswith("<!--")):
            if comment is None:
                comment = [stripped.removeprefix("<!--")]
            else:
                comment.append(line)
            if "-->" in line:
                content = "\n".join(comment).split("-->", 1)[0]
                marker = FACT_MARKER_RE.fullmatch(content)
                if marker:
                    section.markers.append(" ".join(marker[1].split()))
                comment = None
            continue
        match = FENCE_RE.match(line)
        if fence is not None:
            delimiter, language, start = fence
            if (
                match
                and match[1][0] == delimiter[0]
                and len(match[1]) >= len(delimiter)
                and not match[2].strip()
            ):
                if language in SHELL_LANGUAGES:
                    try:
                        tokens = shell_tokens("\n".join(body))
                    except ValueError as error:
                        section.errors.append(
                            f"{path}:{start}: invalid shell example: {error}"
                        )
                    else:
                        if tokens:
                            if section.shell_tokens:
                                section.shell_tokens.append("\n")
                            section.shell_tokens.extend(tokens)
                fence = None
            else:
                body.append(line)
            continue
        if match:
            fence = (match[1], match[2].strip().lower(), line_number)
            if fence[1] not in SHELL_LANGUAGES:
                section.blocks["example"] += 1
            paragraph = False
            body = []
            continue
        heading = HEADING_RE.match(line)
        if heading:
            paragraph = False
            marker, text = heading.groups()
            number = NUMBERED_HEADING_RE.match(text)
            result.append(
                Section(
                    heading=Heading(
                        line_number, len(marker), number[1] if number else None, text
                    )
                )
            )
        elif stripped:
            # The standard translation disclaimer has no English counterpart.
            if stripped.startswith("本文为 ") and "的中文译文" in stripped:
                continue
            if re.match(r"^\s*([-+*]|\d+[.)])\s+", line):
                section.blocks["list item"] += 1
                paragraph = True
            elif stripped.startswith("|") and stripped.endswith("|"):
                if not re.fullmatch(r"[| :\-]+", stripped):
                    section.blocks["table row"] += 1
                paragraph = False
            elif re.fullmatch(r"(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,}", stripped):
                paragraph = False
            elif stripped.startswith(">"):
                if not paragraph:
                    section.blocks["blockquote paragraph"] += 1
                paragraph = bool(stripped.lstrip("> "))
            elif not paragraph:
                section.blocks["paragraph"] += 1
                paragraph = True
    if fence is not None:
        result[-1].errors.append(f"{path}:{fence[2]}: unclosed code fence")
    return result


def pair_failures(
    root: Path, english: str, translated: str, warnings: list[str] | None = None
) -> list[str]:
    english_path = root / english
    translated_path = root / translated
    if not english_path.is_file():
        return [f"{translated} has no English source pair: {english}"]
    english_sections = sections(english_path)
    translated_sections = sections(translated_path)
    failures = [
        error
        for section in english_sections + translated_sections
        for error in section.errors
    ]
    if len(english_sections) != len(translated_sections):
        return failures + [
            f"{english} and {translated} have different heading counts: {len(english_sections) - 1} != {len(translated_sections) - 1}"
        ]
    for english_section, translated_section in zip(
        english_sections, translated_sections
    ):
        if (
            english_section.heading
            and translated_section.heading
            and english_section.heading.signature
            != translated_section.heading.signature
        ):
            failures.append(
                f"{english}:{english_section.line} and {translated}:{translated_section.line} heading structures differ: {english_section.heading.signature} {english_section.heading.text!r} != {translated_section.heading.signature} {translated_section.heading.text!r}"
            )
    if failures:
        return failures
    for english_section, translated_section in zip(
        english_sections, translated_sections
    ):
        location = f"{english}:{english_section.line} and {translated}:{translated_section.line}"
        if warnings is not None and english_section.blocks != translated_section.blocks:
            warnings.append(
                f"{location} content block counts differ: {dict(english_section.blocks)} != {dict(translated_section.blocks)}"
            )
        missing = Counter(english_section.markers) - Counter(translated_section.markers)
        extra = Counter(translated_section.markers) - Counter(english_section.markers)
        if missing or extra:
            failures.append(
                f"{location} fact markers differ: missing {dict(missing)}, extra {dict(extra)}"
            )
        if english_section.shell_tokens != translated_section.shell_tokens:
            index = next(
                (
                    i
                    for i, (x, y) in enumerate(
                        zip(
                            english_section.shell_tokens,
                            translated_section.shell_tokens,
                        )
                    )
                    if x != y
                ),
                min(
                    len(english_section.shell_tokens),
                    len(translated_section.shell_tokens),
                ),
            )
            expected = english_section.shell_tokens[index : index + 5]
            actual = translated_section.shell_tokens[index : index + 5]
            failures.append(
                f"{location} shell examples differ near token {index + 1}: {expected!r} != {actual!r}"
            )
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Check translated Markdown headings, fact markers, and shell examples."
    )
    parser.add_argument(
        "root",
        nargs="?",
        default=Path(__file__).resolve().parents[2],
        type=Path,
        help="repository root to scan",
    )
    args = parser.parse_args()

    root = args.root.resolve()
    failures: list[str] = []
    warnings: list[str] = []
    for english, translated in translated_doc_pairs(root):
        failures.extend(pair_failures(root, english, translated, warnings))

    for warning in warnings:
        print(
            f"Possible translation omission (review only): {warning}", file=sys.stderr
        )

    if failures:
        print("Translated document structure or example drift:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1

    print("Translated document headings, fact markers, and shell examples ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
