#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Fixed disposable credentials; never read the operator's .env or use its data.
export POSTGRES_USER=sec_review_bot POSTGRES_PASSWORD=smoke-postgres
export REVIEW_RUNS_POSTGRES_PASSWORD=smoke-review-runs
export MEMORY_CATALOG_POSTGRES_PASSWORD=smoke-memory-catalog
export EXECUTION_API_TOKEN=smoke-execution
export REVIEW_RUNS_SERVICE_TOKEN=smoke-service REVIEW_RUNS_READ_TOKEN=smoke-read
export REVIEW_RUNS_ADMIN_TOKEN='' CONNECTOR_ID=smoke
export AGENT_MEMORY_CATALOG_TOKEN=smoke-worker
export AGENT_MEMORY_CATALOG_OPERATOR_TOKEN=smoke-operator
export CONTROL_PLANE_UI_ACCESS_TOKEN=smoke-ui-login
export RUSTFS_ROOT_PASSWORD=unused-smoke-password
export SEC_REVIEW_INTEGRATION_S3_ACCESS_KEY=smoke-integration
export SEC_REVIEW_EXECUTION_S3_ACCESS_KEY=smoke-execution-worker
export SEC_REVIEW_MEMORY_S3_ACCESS_KEY=smoke-memory-worker
export SEC_REVIEW_UI_S3_ACCESS_KEY=smoke-ui
export RUSTFS_ROOT_USER=smoke-root
export SEC_REVIEW_INTEGRATION_S3_SECRET_KEY=smoke-integration-secret
export SEC_REVIEW_EXECUTION_S3_SECRET_KEY=smoke-execution-secret
export SEC_REVIEW_MEMORY_S3_SECRET_KEY=smoke-memory-secret SEC_REVIEW_UI_S3_SECRET_KEY=smoke-ui-secret
export LANGFUSE_BASE_URL='' LANGFUSE_PUBLIC_KEY='' LANGFUSE_SECRET_KEY=''
export TEMPORAL_NAMESPACE=default

compose=(docker compose --env-file /dev/null
  --project-name "sec-review-smoke-$(date +%s)-$$"
  --profile app --profile memory
  -f compose.yaml -f smoke-tests/compose.test.yaml)
services=(execution-gateway review-runs memory-catalog-server)

# Options before -- belong to Compose; arguments after it belong to the probe.
probe() {
  local -a options=()
  while (($#)) && [[ "$1" != -- ]]; do
    options+=("$1")
    shift
  done
  if (($# < 2)); then
    echo 'Usage: probe [compose options] -- <phase> [arguments]' >&2
    return 2
  fi
  shift
  "${compose[@]}" run --rm -T --no-deps "${options[@]}" smoke-probe dist/probe.js "$@"
}

describe() {
  "${compose[@]}" exec -T temporal temporal workflow describe \
    --workflow-id "$1" --output json --raw
}

cleanup() {
  local result=$?
  trap - EXIT
  if ((result != 0)); then
    "${compose[@]}" ps --all || true
    "${compose[@]}" logs --no-color --tail 150 || true
  fi
  if ! "${compose[@]}" down --volumes --remove-orphans --timeout 10; then
    result=1
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Rebuild current sources; Docker retains unchanged layers between local runs.
"${compose[@]}" build "${services[@]}" control-plane-ui rustfs-init smoke-probe
"${compose[@]}" up -d --wait --wait-timeout 120 --no-build "${services[@]}" rustfs

# Run the production initializer; probes use their own Node image.
"${compose[@]}" run --rm -T --no-deps rustfs-init
"${compose[@]}" up -d --wait --wait-timeout 60 --no-build --no-deps control-plane-ui
SMOKE_ADMISSION=$(probe -- admit)
export SMOKE_ADMISSION
SMOKE_INPUT_BUNDLE=$("${compose[@]}" run --rm -T --no-deps -e SMOKE_ADMISSION smoke-probe dist/storage-probe.js)
export SMOKE_INPUT_BUNDLE

# Submit the real object reference verified by the storage probe.
run_id=$(probe -e SMOKE_INPUT_BUNDLE -e SMOKE_ADMISSION -- submit)
# Compare Temporal execution identities across identical and conflicting replays.
before=$(describe "$run_id")
probe -e SMOKE_INPUT_BUNDLE -- verify-replay "$run_id"
after=$(describe "$run_id")
probe -- verify-execution-identity "$run_id" "$before" "$after"

# A fresh Gateway process must read and replay the original Temporal execution.
"${compose[@]}" stop --timeout 10 execution-gateway
"${compose[@]}" up -d --wait --wait-timeout 60 --no-build --no-deps execution-gateway
probe -e SMOKE_INPUT_BUNDLE -- verify-replay "$run_id"
after_restart=$(describe "$run_id")
probe -- verify-execution-identity "$run_id" "$before" "$after_restart"

# Terminate the Temporal execution while Review Runs is offline to verify recovery.
"${compose[@]}" stop --timeout 10 review-runs
"${compose[@]}" exec -T temporal temporal workflow terminate \
  --workflow-id "$run_id" --reason 'Compose smoke cleanup'

"${compose[@]}" up -d --wait --wait-timeout 60 --no-build --no-deps review-runs

# Verify persisted task data and observation after the process restart.
probe -- verify-recovery "$run_id"

# Exercise the production console BFF against the real coordination and storage services.
probe -- verify-bff "$run_id"
