#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT HUP INT TERM

cat > "$work_dir/deployment.env" <<'EOF'
# Comments and blank lines are not projected.

SEC_REVIEW_BOT_DIR=/repo
SEC_REVIEW_SERVICE_UID=1000
SEC_REVIEW_SERVICE_GID=1000
SEC_REVIEW_AGENTS_DIR=/repo/agents
SEC_REVIEW_EXECUTION_S3_SECRET_KEY=execution-secret
SEC_REVIEW_MEMORY_S3_SECRET_KEY=memory-secret
AGENT_MEMORY_CATALOG_TOKEN=worker-token
CONTROL_PLANE_UI_ACCESS_TOKEN=ui-secret
EOF

filter_environment() {
  allowed_keys=$1
  output=$2
  awk -v allowed_keys="$allowed_keys" \
    -f "$script_dir/filter-environment.awk" \
    "$work_dir/deployment.env" > "$output"
}

filter_environment \
  'SEC_REVIEW_BOT_DIR SEC_REVIEW_SERVICE_UID SEC_REVIEW_SERVICE_GID' \
  "$work_dir/compose.env"
filter_environment \
  'SEC_REVIEW_AGENTS_DIR SEC_REVIEW_EXECUTION_S3_SECRET_KEY AGENT_MEMORY_CATALOG_TOKEN' \
  "$work_dir/execution-worker.env"
filter_environment \
  'SEC_REVIEW_AGENTS_DIR SEC_REVIEW_MEMORY_S3_SECRET_KEY AGENT_MEMORY_CATALOG_TOKEN' \
  "$work_dir/memory-worker.env"

cat > "$work_dir/expected-compose.env" <<'EOF'
SEC_REVIEW_BOT_DIR=/repo
SEC_REVIEW_SERVICE_UID=1000
SEC_REVIEW_SERVICE_GID=1000
EOF
cat > "$work_dir/expected-execution-worker.env" <<'EOF'
SEC_REVIEW_AGENTS_DIR=/repo/agents
SEC_REVIEW_EXECUTION_S3_SECRET_KEY=execution-secret
AGENT_MEMORY_CATALOG_TOKEN=worker-token
EOF
cat > "$work_dir/expected-memory-worker.env" <<'EOF'
SEC_REVIEW_AGENTS_DIR=/repo/agents
SEC_REVIEW_MEMORY_S3_SECRET_KEY=memory-secret
AGENT_MEMORY_CATALOG_TOKEN=worker-token
EOF

cmp "$work_dir/expected-compose.env" "$work_dir/compose.env"
cmp "$work_dir/expected-execution-worker.env" "$work_dir/execution-worker.env"
cmp "$work_dir/expected-memory-worker.env" "$work_dir/memory-worker.env"
