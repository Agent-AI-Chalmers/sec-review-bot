#!/usr/bin/env bash
set -uo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/patcheval/audit-patcheval-workspaces.sh [options]

Audits PatchEval agent workspaces for a tag and reports per-experiment artifact
status. By default it prints only experiments that are not ready for collection
or have an empty workspace.patch.

Status meanings:
  ok             exit-code.txt is 0 and workspace.patch exists and is non-empty
  empty-patch    exit-code.txt is 0 and workspace.patch exists but is empty
  exit-N         exit-code.txt exists and is non-zero
  missing-*      expected artifact/link/target is missing
  blocked-*      workspace path exists but is not the expected directory/symlink

Options:
  --tag LABEL       Workspace tag. Default: DEEPSEEK-V4-PRO.
  --dataset PATH    PatchEval enriched dataset JSON. If present, audit all CVEs
                    in dataset, including missing workspace directories.
  --existing-only   Audit only CVEs whose workspace directory already exists.
  --all             Print ok experiments too.
  --only-bad        Print only non-ok and non-empty-patch experiments.
  --summary-only    Print only summary counts.
  --no-header       Do not print TSV header.
  -h, --help        Show this help.

Examples:
  scripts/patcheval/audit-patcheval-workspaces.sh
  scripts/patcheval/audit-patcheval-workspaces.sh --only-bad
  scripts/patcheval/audit-patcheval-workspaces.sh --all > /tmp/patcheval-audit.tsv
EOF
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
TAG="DEEPSEEK-V4-PRO"
DATASET="$REPO_ROOT/PatchEval/patcheval/datasets/patcheval_runtime_subset_cleaned.json"
PRINT_ALL=0
ONLY_BAD=0
SUMMARY_ONLY=0
HEADER=1
EXISTING_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)
      if [ $# -lt 2 ]; then
        echo "--tag requires a label" >&2
        exit 2
      fi
      TAG="${2//\//-}"
      shift 2
      ;;
    --dataset)
      if [ $# -lt 2 ]; then
        echo "--dataset requires a path" >&2
        exit 2
      fi
      DATASET="$2"
      shift 2
      ;;
    --all)
      PRINT_ALL=1
      shift
      ;;
    --existing-only)
      EXISTING_ONLY=1
      shift
      ;;
    --only-bad)
      ONLY_BAD=1
      shift
      ;;
    --summary-only)
      SUMMARY_ONLY=1
      shift
      ;;
    --no-header)
      HEADER=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

cd "$REPO_ROOT" || exit 1

if [ -f "$DATASET" ] && ! command -v jq >/dev/null 2>&1; then
  echo "jq is required when --dataset points to an existing JSON file." >&2
  exit 2
fi

EXPERIMENT_SUFFIXES=(
  "end-to-end-default"
  "end-to-end-single-agent"
  "end-to-end-two-stage"
  "location-oracle-default"
  "location-oracle-single-agent"
  "location-oracle-two-stage"
)

first_workspace_patch() {
  local run_dir="$1"
  local artifacts="$run_dir/artifacts/$(basename "$run_dir")"
  local path

  # PatchEval CVE experiments currently use issue/PR-style workflow artifacts.
  # This helper is not repository-delivery-aware.
  for path in \
    "$artifacts/mitigator/workspace.patch" \
    "$artifacts/single-agent/workspace.patch"
  do
    if [ -f "$path" ]; then
      printf '%s\n' "$path"
      return 0
    fi
  done

  for path in "$artifacts"/*/workspace.patch; do
    if [ -f "$path" ]; then
      printf '%s\n' "$path"
      return 0
    fi
  done

  find "$artifacts" -name workspace.patch -type f 2>/dev/null | sort | head -n1
}

audit_experiment() {
  local cve="$1"
  local suffix="$2"
  local workspace="$REPO_ROOT/.agent-workspace-patcheval-${cve}-${TAG}"
  local experiment="${cve}-${suffix}"
  local link="$workspace/$experiment"
  local target=""
  local run_dir=""
  local exit_code=""
  local patch_path=""
  local patch_bytes=""

  if [ ! -e "$workspace" ]; then
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$cve" "$suffix" "missing-workspace" "" "" ""
    return 0
  fi

  if [ ! -d "$workspace" ]; then
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$cve" "$suffix" "blocked-workspace" "" "" "$workspace"
    return 0
  fi

  if [ ! -e "$link" ]; then
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$cve" "$suffix" "missing-symlink" "" "" "$link"
    return 0
  fi

  if [ ! -L "$link" ]; then
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$cve" "$suffix" "blocked-non-symlink" "" "" "$link"
    return 0
  fi

  target="$(readlink "$link")"
  run_dir="$workspace/$target"
  if [ ! -d "$run_dir" ]; then
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$cve" "$suffix" "missing-target" "" "" "$run_dir"
    return 0
  fi

  if [ ! -f "$run_dir/exit-code.txt" ]; then
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$cve" "$suffix" "missing-exit-code" "" "" "$run_dir"
    return 0
  fi

  exit_code="$(tr -d '[:space:]' < "$run_dir/exit-code.txt")"
  if [ "$exit_code" != "0" ]; then
    printf '%s\t%s\texit-%s\t%s\t%s\t%s\n' "$cve" "$suffix" "$exit_code" "$exit_code" "" "$run_dir"
    return 0
  fi

  patch_path="$(first_workspace_patch "$run_dir")"
  if [ -z "$patch_path" ]; then
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$cve" "$suffix" "missing-patch" "$exit_code" "" "$run_dir"
    return 0
  fi

  patch_bytes="$(wc -c < "$patch_path")"
  if [ "$patch_bytes" -eq 0 ]; then
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$cve" "$suffix" "empty-patch" "$exit_code" "$patch_bytes" "$run_dir"
  else
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$cve" "$suffix" "ok" "$exit_code" "$patch_bytes" "$run_dir"
  fi
}

mapfile -t CVES < <(
  if [ -f "$DATASET" ]; then
    jq -r '.[].cve_id' "$DATASET"
  else
    find "$REPO_ROOT" -maxdepth 1 -type d -name ".agent-workspace-patcheval-CVE-*-${TAG}" -printf '%f\n' \
      | sed -E "s/^\\.agent-workspace-patcheval-(CVE-[0-9]+-[0-9]+)-${TAG}$/\\1/" \
      | sort
  fi
)

if [ "${#CVES[@]}" -eq 0 ]; then
  echo "No CVEs found to audit." >&2
  exit 2
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

for cve in "${CVES[@]}"; do
  if [ "$EXISTING_ONLY" -eq 1 ] && [ ! -d "$REPO_ROOT/.agent-workspace-patcheval-${cve}-${TAG}" ]; then
    continue
  fi
  for suffix in "${EXPERIMENT_SUFFIXES[@]}"; do
    audit_experiment "$cve" "$suffix" >> "$tmp"
  done
done

if [ "$SUMMARY_ONLY" -eq 0 ] && [ "$HEADER" -eq 1 ]; then
  printf 'cve\texperiment\tstatus\texit_code\tpatch_bytes\trun_dir\n'
fi

if [ "$SUMMARY_ONLY" -eq 0 ]; then
  if [ "$PRINT_ALL" -eq 1 ]; then
    cat "$tmp"
  elif [ "$ONLY_BAD" -eq 1 ]; then
    awk -F '\t' '$3 != "ok" && $3 != "empty-patch"' "$tmp"
  else
    awk -F '\t' '$3 != "ok"' "$tmp"
  fi
fi

echo
echo "Summary:"
awk -F '\t' '
  { count[$3] += 1; total += 1 }
  END {
    printf "  total: %d\n", total
    for (status in count) {
      printf "  %s: %d\n", status, count[status]
    }
  }
' "$tmp" | sort
