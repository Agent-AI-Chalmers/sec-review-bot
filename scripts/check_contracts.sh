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
  cd "$ROOT/apps/github-integration"
  npm run lint
  npm run build
  node --test --test-reporter=spec \
    dist/test/contracts/contract-schemas.test.js \
    dist/test/contracts/repository-result.test.js \
    dist/test/contracts/review-record.test.js
)
