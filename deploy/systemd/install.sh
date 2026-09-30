#!/bin/sh
set -eu

# Installation writes to /etc and normalizes repository state ownership. The
# service itself still runs as the unprivileged user passed by the operator.
if [ "$(id -u)" -ne 0 ]; then
    echo "Run this installer as root: sudo deploy/systemd/install.sh <service-user>" >&2
    exit 1
fi

service_user=${1:-}
if [ -z "$service_user" ]; then
    echo "Usage: sudo deploy/systemd/install.sh <service-user>" >&2
    exit 1
fi
if ! id "$service_user" >/dev/null 2>&1; then
    echo "Unknown service user: $service_user" >&2
    exit 1
fi
case "$service_user" in
    *[!A-Za-z0-9_.-]*|'')
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
deployment_env_source=$script_dir/deployment.env
# Render into a private temporary file so a rendering failure cannot truncate
# the previously installed configuration under /etc.
rendered_deployment_env=$(mktemp)
trap 'rm -f "$rendered_deployment_env"' EXIT HUP INT TERM

# Fail before installing units that cannot run under the selected service user.
if [ ! -x "$repository_root/agents/.venv/bin/sec-review-agents-worker" ]; then
    echo "Missing agents worker executable." >&2
    echo "Run 'uv sync --frozen --no-dev' in $repository_root/agents first." >&2
    exit 1
fi
if ! /usr/sbin/runuser -u "$service_user" -- \
    test -x "$repository_root/agents/.venv/bin/sec-review-agents-worker"; then
    echo "The service user cannot execute the agents worker." >&2
    exit 1
fi
if ! /usr/sbin/runuser -u "$service_user" -- \
    /usr/bin/env docker info >/dev/null 2>&1; then
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
    "$repository_root/.agent-input-bundles" \
    "$repository_root/.agent-app-state" \
    "$repository_root/.agent-artifacts"
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
        fixed["SEC_REVIEW_AGENT_INPUT_BUNDLE_ROOT"] = 1
        fixed["SEC_REVIEW_SERVICE_UID"] = 1
        fixed["SEC_REVIEW_SERVICE_GID"] = 1
        optional["SEC_REVIEW_AGENT_ARTIFACT_ROOT"] = 1
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
        print "SEC_REVIEW_AGENT_INPUT_BUNDLE_ROOT=" \
            repository_root "/.agent-input-bundles"
        print "SEC_REVIEW_SERVICE_UID=" service_uid
        print "SEC_REVIEW_SERVICE_GID=" service_gid

        if (configured["SEC_REVIEW_AGENT_ARTIFACT_ROOT"] != "") {
            print configured["SEC_REVIEW_AGENT_ARTIFACT_ROOT"]
        } else {
            print "SEC_REVIEW_AGENT_ARTIFACT_ROOT=" \
                repository_root "/.agent-artifacts"
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
' "$deployment_env_source" >"$rendered_deployment_env"
# Copy only the completed merged file and keep deployment secrets private.
install -m 0600 "$rendered_deployment_env" "$deployment_env"

# Unit templates contain only the service-user placeholder. Deployment values
# remain in the EnvironmentFile so changing them does not rewrite unit files.
render_unit() {
    source_path=$1
    target_path=$2
    escaped_service_user=$(printf '%s' "$service_user" | sed 's/[&|]/\\&/g')
    sed "s|@SEC_REVIEW_BOT_USER@|$escaped_service_user|g" \
        "$source_path" >"$target_path"
    chmod 0644 "$target_path"
}

install -m 0644 \
    "$script_dir/sec-review-bot.target" \
    "$unit_dir/sec-review-bot.target"
render_unit \
    "$script_dir/sec-review-bot-control-plane.service.in" \
    "$unit_dir/sec-review-bot-control-plane.service"
render_unit \
    "$script_dir/sec-review-agents-worker@.service.in" \
    "$unit_dir/sec-review-agents-worker@.service"

systemctl daemon-reload

echo "Installed Sec Review Bot systemd units for user '$service_user'."
echo "Installed $deployment_env from $deployment_env_source with repository paths."
echo "Review it, then run:"
echo "  systemctl enable --now sec-review-bot.target"
