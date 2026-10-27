import os
import re
import sys
from pathlib import Path

REQUIRED_SECTIONS = ("Summary", "Compatibility", "Validation")
COMPATIBILITY_CLASSIFICATIONS = (
    "No compatibility impact",
    "Backward-compatible behavior change",
    "Breaking change",
)
OPTION_PATTERN = re.compile(r"^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*\.?\s*$", re.MULTILINE)


def visible_text(lines: list[str]) -> str:
    return re.sub(r"<!--[\s\S]*?-->", "", "\n".join(lines)).strip()


def required_sections(body: str) -> dict[str, list[str]]:
    sections: dict[str, list[str]] = {}
    current_section: str | None = None

    for line in body.splitlines():
        heading = re.fullmatch(r"##\s+(.+?)\s*", line)
        if heading:
            current_section = heading.group(1)
            if current_section in REQUIRED_SECTIONS:
                if current_section in sections:
                    raise ValueError(
                        f"Duplicate required section: ## {current_section}"
                    )
                sections[current_section] = []
            continue
        if current_section in sections:
            sections[current_section].append(line)

    for section in REQUIRED_SECTIONS:
        if section not in sections:
            raise ValueError(f"Missing required section: ## {section}")
        if not visible_text(sections[section]):
            raise ValueError(f"Required section is empty: ## {section}")
    return sections


def validate_compatibility(lines: list[str]) -> None:
    compatibility = visible_text(lines)
    options = [
        (marker.lower() == "x", classification)
        for marker, classification in OPTION_PATTERN.findall(compatibility)
    ]
    seen = [
        classification
        for _, classification in options
        if classification in COMPATIBILITY_CLASSIFICATIONS
    ]
    missing = [
        classification
        for classification in COMPATIBILITY_CLASSIFICATIONS
        if classification not in seen
    ]
    duplicates = [
        classification
        for classification in COMPATIBILITY_CLASSIFICATIONS
        if seen.count(classification) > 1
    ]
    unknown = [
        classification
        for _, classification in options
        if classification not in COMPATIBILITY_CLASSIFICATIONS
    ]
    if missing or duplicates or unknown:
        supported = ", ".join(COMPATIBILITY_CLASSIFICATIONS)
        raise ValueError(
            "## Compatibility must contain each supported checkbox exactly once: "
            f"{supported}"
        )

    selected = [classification for checked, classification in options if checked]
    if not selected:
        raise ValueError("No compatibility classification is selected.")
    if len(selected) > 1:
        raise ValueError(
            "Multiple compatibility classifications are selected: "
            + ", ".join(selected)
        )

    if selected[0] == "Breaking change":
        explanation = OPTION_PATTERN.sub("", compatibility).strip()
        if not explanation:
            raise ValueError(
                "Breaking change must describe what breaks and how callers or "
                "operators migrate."
            )


def validate_pull_request_description(body: str, author: str = "") -> None:
    if author == "dependabot[bot]":
        if not body.strip():
            raise ValueError("Dependabot pull request description is empty.")
        return

    sections = required_sections(body)
    validate_compatibility(sections["Compatibility"])


def main() -> int:
    body = (
        Path(sys.argv[1]).read_text(encoding="utf-8")
        if len(sys.argv) > 1
        else os.environ.get("PR_BODY", "")
    )
    try:
        validate_pull_request_description(body, os.environ.get("PR_AUTHOR", ""))
    except ValueError as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
