#!/bin/sh
set -eu

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
unit_dir=/etc/systemd/system
config_dir=/etc/sec-review-bot
deployment_env=$config_dir/deployment.env

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
if [ -L "$deployment_env" ]; then
    echo "Refusing to use a symbolic link as deployment config: $deployment_env" >&2
    exit 1
fi
if [ ! -e "$deployment_env" ]; then
    escaped_repository_root=$(printf '%s' "$repository_root" | sed 's/[&|]/\\&/g')
    sed "s|/absolute/path/to/sec-review-bot|$escaped_repository_root|g" \
        "$script_dir/deployment.env.sample" >"$deployment_env"
elif [ ! -f "$deployment_env" ]; then
    echo "Deployment config is not a regular file: $deployment_env" >&2
    exit 1
fi
chown root:root "$deployment_env"
chmod 0600 "$deployment_env"

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
echo "Review $deployment_env, then run:"
echo "  systemctl enable --now sec-review-bot.target"
