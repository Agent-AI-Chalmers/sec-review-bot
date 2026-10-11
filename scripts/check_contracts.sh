#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python "$ROOT/scripts/check_translated_doc_headings.py" "$ROOT"
python "$ROOT/scripts/check_markdown_links.py" "$ROOT"
python "$ROOT/scripts/check_markdown_wrapping.py" "$ROOT"

(
  cd "$ROOT/agents"
  uv run python -m pytest tests/contracts -q
)

(
  cd "$ROOT/control-plane"
  # The observed-run contract: the key-set check runs through tsc, the value-level check
  # through the shared fixtures.
  pnpm run typecheck
  node --import tsx --test test/observed-run-contract.test.ts
)

(
  cd "$ROOT/apps/github-integration"
  pnpm run lint
  # The client's record mirror is a type-only check, so it needs tsc rather than the runner.
  pnpm run typecheck
  pnpm run build
  # The production build intentionally excludes test/; run the contract tests from source.
  node --import tsx --test --test-reporter=spec \
    test/control-plane/client-operation-surface.test.ts \
    test/contracts/contract-schemas.test.ts \
    test/contracts/repository-result.test.ts \
    test/contracts/review-record.test.ts
)
