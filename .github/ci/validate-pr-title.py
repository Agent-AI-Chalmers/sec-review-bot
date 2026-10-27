import os
import re
import sys

TITLE_PATTERN = re.compile(
    r"^(feat|fix|refactor|docs|test|chore|build|ci)"
    r"(\([a-z0-9][a-z0-9._/-]*\))?!?: \S(?:.*\S)?$"
)


def validate_pull_request_title(title: str) -> None:
    if TITLE_PATTERN.fullmatch(title):
        return
    raise ValueError(
        f"Invalid pull request title: {title}\n"
        "Expected: <type>(<optional-scope>): <concise summary>\n"
        "Allowed types: feat, fix, refactor, docs, test, chore, build, ci"
    )


def main() -> int:
    if len(sys.argv) > 2:
        print("Usage: validate-pr-title.py [title]", file=sys.stderr)
        return 2
    title = sys.argv[1] if len(sys.argv) == 2 else os.environ.get("PR_TITLE", "")
    try:
        validate_pull_request_title(title)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
