#!/bin/sh
set -eu

# Installation writes to /etc and normalizes repository state ownership. The
# service itself still runs as the unprivileged user passed by the operator.
if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer as root: sudo ops/systemd/install.sh <service-user>" >&2
  exit 1
fi

service_user=${1:-}
if [ -z "$service_user" ]; then
  echo "Usage: sudo ops/systemd/install.sh <service-user>" >&2
  exit 1
fi
if ! id "$service_user" > /dev/null 2>&1; then
  echo "Unknown service user: $service_user" >&2
  exit 1
fi
case "$service_user" in
  *[!A-Za-z0-9_.-]* | '')
    echo "Unsupported service user name: $service_user" >&2
    exit 1
    ;;
esac

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
service_uid=$(id -u "$service_user")
service_gid=$(id -g "$service_user")
unit_dir=/etc/systemd/system
config_dir=/etc/sec-review-bot
deployment_env=$config_dir/deployment.env
compose_env=$config_dir/compose.env
execution_worker_env=$config_dir/execution-worker.env
memory_worker_env=$config_dir/memory-worker.env
deployment_env_source=$script_dir/deployment.env
# Render into a private temporary file so a rendering failure cannot truncate
# the previously installed configuration under /etc.
rendered_deployment_env=$(mktemp)
rendered_compose_env=$(mktemp)
rendered_execution_worker_env=$(mktemp)
rendered_memory_worker_env=$(mktemp)
trap 'rm -f "$rendered_deployment_env" "$rendered_compose_env" "$rendered_execution_worker_env" "$rendered_memory_worker_env"' EXIT HUP INT TERM

# Fail before installing units that cannot run under the selected service user.
if [ ! -x "$repository_root/agents/.venv/bin/sec-review-execution-worker" ] ||
  [ ! -x "$repository_root/agents/.venv/bin/sec-review-memory-extraction-worker" ] ||
  [ ! -x "$repository_root/agents/.venv/bin/sec-review-memory-maintenance-worker" ]; then
  echo "Missing execution, memory extraction, or memory maintenance worker executable." >&2
  echo "Run 'uv sync --frozen --no-dev' in $repository_root/agents first." >&2
  exit 1
fi
if ! /usr/sbin/runuser -u "$service_user" -- \
  test -x "$repository_root/agents/.venv/bin/sec-review-execution-worker"; then
  echo "The service user cannot execute the execution worker." >&2
  exit 1
fi
if ! /usr/sbin/runuser -u "$service_user" -- \
  test -x "$repository_root/agents/.venv/bin/sec-review-memory-extraction-worker"; then
  echo "The service user cannot execute the memory extraction worker." >&2
  exit 1
fi
if ! /usr/sbin/runuser -u "$service_user" -- \
  test -x "$repository_root/agents/.venv/bin/sec-review-memory-maintenance-worker"; then
  echo "The service user cannot execute the memory maintenance worker." >&2
  exit 1
fi
if ! /usr/sbin/runuser -u "$service_user" -- \
  /usr/bin/env docker info > /dev/null 2>&1; then
  echo "The service user cannot access the Docker daemon." >&2
  exit 1
fi

install -d -m 0755 "$config_dir"
# Create bind-mount sources before Compose runs. Otherwise Docker creates
# missing directories as root, and non-root containers cannot initialize them.
# Re-running the installer also restores these default directories to the
# selected service user after an earlier root-owned deployment.
install -d -m 0755 -o "$service_uid" -g "$service_gid" \
  "$repository_root/.agent-temporal-state" \
  "$repository_root/.agent-rustfs-state" \
  "$repository_root/.agent-postgres-state" \
  "$repository_root/.agent-artifacts" \
  "$repository_root/.agent-run-inputs"
# GNU install preserves the owner of directories that already exist. Correct
# the bind-mount roots explicitly without traversing potentially large state.
chown "$service_uid:$service_gid" \
  "$repository_root/.agent-temporal-state" \
  "$repository_root/.agent-rustfs-state" \
  "$repository_root/.agent-postgres-state" \
  "$repository_root/.agent-artifacts" \
  "$repository_root/.agent-run-inputs"
if [ ! -f "$deployment_env_source" ]; then
  echo "Missing deployment config: $deployment_env_source" >&2
  echo "Copy deployment.env.sample to deployment.env and fill in its values first." >&2
  exit 1
fi
# Checkout paths shared with Compose must move together. Artifact and model
# paths have repository-local defaults, but remain independent worker choices.
# The renderer therefore has three policies: replace installer-owned values,
# preserve non-empty optional overrides, and copy every unrelated source line.
awk -v repository_root="$repository_root" \
  -v service_uid="$service_uid" \
  -v service_gid="$service_gid" '
    BEGIN {
        fixed["SEC_REVIEW_BOT_DIR"] = 1
        fixed["SEC_REVIEW_AGENTS_DIR"] = 1
        fixed["SEC_REVIEW_SERVICE_UID"] = 1
        fixed["SEC_REVIEW_SERVICE_GID"] = 1
        optional["SEC_REVIEW_AGENT_ARTIFACT_ROOT"] = 1
        optional["SEC_REVIEW_AGENT_RUN_INPUT_ROOT"] = 1
        optional["MODEL_PROVIDERS_CONFIG_TOML"] = 1
    }
    {
        # systemd ignores leading whitespace before an EnvironmentFile
        # assignment. Normalize only the lookup copy.
        key = $0
        sub(/^[ \t\r]+/, "", key)
        sub(/=.*/, "", key)
        if (fixed[key]) next
        if (optional[key]) {
            # Empty optional assignments mean "use the checkout default".
            value = $0
            sub(/^[^=]*=/, "", value)
            if (value != "") configured[key] = key "=" value
            next
        }
        retained[++retained_count] = $0
    }
    END {
        print "SEC_REVIEW_BOT_DIR=" repository_root
        print "SEC_REVIEW_AGENTS_DIR=" repository_root "/agents"
        print "SEC_REVIEW_SERVICE_UID=" service_uid
        print "SEC_REVIEW_SERVICE_GID=" service_gid

        if (configured["SEC_REVIEW_AGENT_ARTIFACT_ROOT"] != "") {
            print configured["SEC_REVIEW_AGENT_ARTIFACT_ROOT"]
        } else {
            print "SEC_REVIEW_AGENT_ARTIFACT_ROOT=" \
                repository_root "/.agent-artifacts"
        }
        if (configured["SEC_REVIEW_AGENT_RUN_INPUT_ROOT"] != "") {
            print configured["SEC_REVIEW_AGENT_RUN_INPUT_ROOT"]
        } else {
            print "SEC_REVIEW_AGENT_RUN_INPUT_ROOT=" \
                repository_root "/.agent-run-inputs"
        }
        if (configured["MODEL_PROVIDERS_CONFIG_TOML"] != "") {
            print configured["MODEL_PROVIDERS_CONFIG_TOML"]
        } else {
            print "MODEL_PROVIDERS_CONFIG_TOML=" \
                repository_root "/agents/config/model-providers.toml"
        }

        for (line_number = 1; line_number <= retained_count; line_number++) {
            print retained[line_number]
        }
    }
' "$deployment_env_source" > "$rendered_deployment_env"
# Keep the completed merged source private for operator inspection.
install -m 0600 "$rendered_deployment_env" "$deployment_env"

filter_environment() {
  allowed_keys=$1
  output=$2
  awk -v allowed_keys="$allowed_keys" \
    -f "$script_dir/filter-environment.awk" \
    "$rendered_deployment_env" > "$output"
}

filter_environment \
  'SEC_REVIEW_BOT_DIR SEC_REVIEW_SERVICE_UID SEC_REVIEW_SERVICE_GID' \
  "$rendered_compose_env"
filter_environment \
  'SEC_REVIEW_AGENTS_DIR SEC_REVIEW_AGENT_ARTIFACT_ROOT SEC_REVIEW_AGENT_RUN_INPUT_ROOT MODEL_PROVIDERS_CONFIG_TOML TEMPORAL_ADDRESS TEMPORAL_NAMESPACE TEMPORAL_EXECUTION_TASK_QUEUE TEMPORAL_EXECUTION_MAX_CONCURRENT_ACTIVITIES SEC_REVIEW_ARTIFACT_S3_BUCKET SEC_REVIEW_ARTIFACT_S3_ENDPOINT SEC_REVIEW_ARTIFACT_S3_ADDRESSING_STYLE AWS_REGION SEC_REVIEW_EXECUTION_S3_ACCESS_KEY SEC_REVIEW_EXECUTION_S3_SECRET_KEY AGENT_SANDBOX_BACKEND AGENT_DOCKER_BIN AGENT_DOCKER_NETWORK_MODE AGENT_DOCKER_IMAGE AGENT_MEMORY_CATALOG_URL AGENT_MEMORY_CATALOG_TOKEN AGENT_MEMORY_CONSUMPTION_ENABLED AGENT_SKILLS_ENABLED AGENT_JOERN_ENABLED AGENT_PLAYWRIGHT_ENABLED AGENT_MCP_ENABLED LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY LANGFUSE_BASE_URL' \
  "$rendered_execution_worker_env"
filter_environment \
  'SEC_REVIEW_AGENTS_DIR SEC_REVIEW_AGENT_ARTIFACT_ROOT SEC_REVIEW_AGENT_RUN_INPUT_ROOT MODEL_PROVIDERS_CONFIG_TOML TEMPORAL_ADDRESS TEMPORAL_NAMESPACE TEMPORAL_MEMORY_EXTRACTION_MAX_CONCURRENT_ACTIVITIES TEMPORAL_MEMORY_MAINTENANCE_MAX_CONCURRENT_ACTIVITIES SEC_REVIEW_ARTIFACT_S3_BUCKET SEC_REVIEW_ARTIFACT_S3_ENDPOINT SEC_REVIEW_ARTIFACT_S3_ADDRESSING_STYLE AWS_REGION SEC_REVIEW_MEMORY_S3_ACCESS_KEY SEC_REVIEW_MEMORY_S3_SECRET_KEY AGENT_MEMORY_CATALOG_URL AGENT_MEMORY_CATALOG_TOKEN AGENT_MEMORY_PROCESSING_ENABLED AGENT_SKILLS_ENABLED AGENT_JOERN_ENABLED AGENT_PLAYWRIGHT_ENABLED AGENT_MCP_ENABLED LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY LANGFUSE_BASE_URL' \
  "$rendered_memory_worker_env"

install -m 0600 "$rendered_compose_env" "$compose_env"
install -m 0600 "$rendered_execution_worker_env" "$execution_worker_env"
install -m 0600 "$rendered_memory_worker_env" "$memory_worker_env"

# Unit templates contain only the service-user placeholder. Deployment values
# remain in the EnvironmentFile so changing them does not rewrite unit files.
render_unit() {
  source_path=$1
  target_path=$2
  escaped_service_user=$(printf '%s' "$service_user" | sed 's/[&|]/\\&/g')
  sed "s|@SEC_REVIEW_BOT_USER@|$escaped_service_user|g" \
    "$source_path" > "$target_path"
  chmod 0644 "$target_path"
}

install -m 0644 \
  "$script_dir/sec-review-bot.target" \
  "$unit_dir/sec-review-bot.target"
render_unit \
  "$script_dir/sec-review-bot-compose-stack.service.in" \
  "$unit_dir/sec-review-bot-compose-stack.service"
render_unit \
  "$script_dir/sec-review-execution-worker@.service.in" \
  "$unit_dir/sec-review-execution-worker@.service"
render_unit \
  "$script_dir/sec-review-memory-extraction-worker@.service.in" \
  "$unit_dir/sec-review-memory-extraction-worker@.service"
render_unit \
  "$script_dir/sec-review-memory-maintenance-worker.service.in" \
  "$unit_dir/sec-review-memory-maintenance-worker.service"

systemctl daemon-reload

echo "Installed Sec Review Bot systemd units for user '$service_user'."
echo "Installed $deployment_env from $deployment_env_source with repository paths."
echo "Installed role-scoped environment files under $config_dir."
echo "Review it, then run:"
echo "  systemctl enable --now sec-review-bot.target"
