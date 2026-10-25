#!/bin/sh
set -eu

# Create one coherent local integrated-deployment configuration. Internal
# credentials are generated here because several of them must be shared across
# Compose services and host workers; asking an operator to copy them by hand is
# both tedious and a common source of mismatched configuration.

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$script_dir/.." && pwd)

compose_env=$repository_root/.env
model_config=$repository_root/agents/config/model-providers.toml
github_env=$repository_root/apps/github-integration/.env
deployment_env=$repository_root/ops/systemd/deployment.env

for target in "$compose_env" "$model_config" "$github_env" "$deployment_env"; do
    if [ -e "$target" ]; then
        echo "Refusing to overwrite existing configuration: $target" >&2
        echo "Move or remove all existing deployment configuration files, then rerun." >&2
        exit 1
    fi
done

if ! command -v openssl >/dev/null 2>&1; then
    echo "openssl is required to generate local deployment credentials." >&2
    exit 1
fi

umask 077
work_dir=$(mktemp -d)
complete=false
cleanup() {
    if [ "$complete" != true ]; then
        # All targets were proven absent before generation, so removing them on
        # failure cannot delete an operator-owned configuration.
        rm -f "$compose_env" "$model_config" "$github_env" "$deployment_env"
    fi
    rm -rf "$work_dir"
}
trap cleanup EXIT HUP INT TERM

random_secret() {
    openssl rand -hex 32
}

replace_assignment() {
    file=$1
    name=$2
    value=$3
    temporary=$file.next
    awk -v name="$name" -v value="$value" '
        BEGIN { replaced = 0 }
        index($0, name "=") == 1 {
            print name "=" value
            replaced = 1
            next
        }
        { print }
        END {
            if (!replaced) exit 1
        }
    ' "$file" >"$temporary"
    mv "$temporary" "$file"
}

control_plane_ui_access_token=$(random_secret)
control_plane_read_token=$(random_secret)
control_plane_service_token=$(random_secret)
control_plane_admin_token=$(random_secret)
execution_api_token=$(random_secret)
memory_catalog_token=$(random_secret)
postgres_password=$(random_secret)
rustfs_root_password=$(random_secret)
integration_storage_password=$(random_secret)
execution_storage_password=$(random_secret)
memory_storage_password=$(random_secret)
ui_storage_password=$(random_secret)

compose_tmp=$work_dir/compose.env
deployment_tmp=$work_dir/deployment.env
github_tmp=$work_dir/github.env
model_tmp=$work_dir/model-providers.toml

cp "$repository_root/compose.env.sample" "$compose_tmp"
cp "$repository_root/ops/systemd/deployment.env.sample" "$deployment_tmp"
cp "$repository_root/apps/github-integration/.env.sample" "$github_tmp"
cp "$repository_root/agents/config/model-providers.sample.toml" "$model_tmp"

replace_assignment "$compose_tmp" CONTROL_PLANE_UI_ACCESS_TOKEN "$control_plane_ui_access_token"
replace_assignment "$compose_tmp" CONTROL_PLANE_READ_TOKEN "$control_plane_read_token"
replace_assignment "$compose_tmp" CONTROL_PLANE_SERVICE_TOKEN "$control_plane_service_token"
replace_assignment "$compose_tmp" CONTROL_PLANE_ADMIN_TOKEN "$control_plane_admin_token"
replace_assignment "$compose_tmp" EXECUTION_API_TOKEN "$execution_api_token"
replace_assignment "$compose_tmp" AGENT_MEMORY_CATALOG_TOKEN "$memory_catalog_token"
replace_assignment "$compose_tmp" POSTGRES_PASSWORD "$postgres_password"
replace_assignment "$compose_tmp" RUSTFS_ROOT_PASSWORD "$rustfs_root_password"
replace_assignment "$compose_tmp" SEC_REVIEW_INTEGRATION_S3_SECRET_KEY "$integration_storage_password"
replace_assignment "$compose_tmp" SEC_REVIEW_EXECUTION_S3_SECRET_KEY "$execution_storage_password"
replace_assignment "$compose_tmp" SEC_REVIEW_MEMORY_S3_SECRET_KEY "$memory_storage_password"
replace_assignment "$compose_tmp" SEC_REVIEW_UI_S3_SECRET_KEY "$ui_storage_password"

# Host workers must use the same role credentials as the corresponding RustFS
# identities and Memory Catalog service configured through Compose.
replace_assignment "$deployment_tmp" SEC_REVIEW_EXECUTION_S3_SECRET_KEY "$execution_storage_password"
replace_assignment "$deployment_tmp" SEC_REVIEW_MEMORY_S3_SECRET_KEY "$memory_storage_password"
replace_assignment "$deployment_tmp" SEC_REVIEW_UI_S3_SECRET_KEY "$ui_storage_password"
replace_assignment "$deployment_tmp" AGENT_MEMORY_CATALOG_TOKEN "$memory_catalog_token"

# Compose overrides this value, but keeping the generated source file coherent
# also makes it usable for focused non-Compose integration runs.
replace_assignment "$github_tmp" CONTROL_PLANE_SERVICE_TOKEN "$control_plane_service_token"
replace_assignment "$github_tmp" PRIVATE_KEY_PATH "\"$repository_root/apps/github-integration/private-key.pem\""

mv "$compose_tmp" "$compose_env"
mv "$model_tmp" "$model_config"
mv "$github_tmp" "$github_env"
mv "$deployment_tmp" "$deployment_env"

chmod 600 "$compose_env" "$model_config" "$github_env" "$deployment_env"
complete=true

cat <<EOF
Created local integrated-deployment configuration:
  .env
  agents/config/model-providers.toml
  apps/github-integration/.env
  ops/systemd/deployment.env

Internal credentials were generated and synchronized. Before starting the
deployment, configure the GitHub App fields and private key, then configure at
least one model deployment and its agent bindings.
EOF
