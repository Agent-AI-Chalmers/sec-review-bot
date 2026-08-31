#!/usr/bin/env bash
set -uo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/patcheval/run-patcheval-experiment-pool.sh [options]

Runs remaining PatchEval experiments as a global experiment-level queue.
Unlike scripts/patcheval/run-patcheval-six.sh, this script does not wait for all
six variants of one CVE before starting the next CVE. It keeps up to --jobs individual
experiments running across CVEs.

By default, an experiment is skipped when its experiment symlink exists, the
target local-run directory exists, exit-code.txt is 0, and workspace.patch
exists. Empty workspace.patch is considered a completed leaderboard-style
artifact.

Options:
  --dataset PATH        PatchEval enriched dataset JSON.
  --tag LABEL           Workspace tag. Default: DEEPSEEK-V4-PRO.
  --jobs N              Max individual experiments to run concurrently. Default: 6.
  --limit N             Run at most N queued experiments.
  --only CVE            Queue only this CVE. Can be repeated.
  --exclude CVE         Exclude this CVE. Can be repeated.
  --resume-incomplete   Rerun existing incomplete experiments.
  --require-nonempty-patch
                        Treat empty workspace.patch as incomplete.
  --dry-run             Print selected experiments and commands without running.
  --max-failures N      Stop launching new experiments after N failures.
  --stop-on-failure     Shortcut for --max-failures 1.
  -h, --help            Show this help.

Examples:
  scripts/patcheval/run-patcheval-experiment-pool.sh --dry-run --limit 12
  scripts/patcheval/run-patcheval-experiment-pool.sh --jobs 6
EOF
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"

DATASET="$REPO_ROOT/PatchEval/patcheval/datasets/patcheval_runtime_subset_cleaned.json"
TAG="DEEPSEEK-V4-PRO"
JOBS=6
LIMIT=""
DRY_RUN=0
RESUME_INCOMPLETE=0
REQUIRE_NONEMPTY_PATCH=0
STOP_ON_FAILURE=0
MAX_FAILURES=""
ONLY=()
EXCLUDE=()

while [ $# -gt 0 ]; do
  case "$1" in
    --dataset)
      if [ $# -lt 2 ]; then
        echo "--dataset requires a path" >&2
        exit 2
      fi
      DATASET="$2"
      shift 2
      ;;
    --tag)
      if [ $# -lt 2 ]; then
        echo "--tag requires a label" >&2
        exit 2
      fi
      TAG="${2//\//-}"
      shift 2
      ;;
    --jobs)
      if [ $# -lt 2 ]; then
        echo "--jobs requires a number" >&2
        exit 2
      fi
      JOBS="$2"
      shift 2
      ;;
    --limit)
      if [ $# -lt 2 ]; then
        echo "--limit requires a number" >&2
        exit 2
      fi
      LIMIT="$2"
      shift 2
      ;;
    --only)
      if [ $# -lt 2 ]; then
        echo "--only requires a CVE id" >&2
        exit 2
      fi
      ONLY+=("$2")
      shift 2
      ;;
    --exclude)
      if [ $# -lt 2 ]; then
        echo "--exclude requires a CVE id" >&2
        exit 2
      fi
      EXCLUDE+=("$2")
      shift 2
      ;;
    --resume-incomplete)
      RESUME_INCOMPLETE=1
      shift
      ;;
    --require-nonempty-patch)
      REQUIRE_NONEMPTY_PATCH=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --stop-on-failure)
      STOP_ON_FAILURE=1
      shift
      ;;
    --max-failures)
      if [ $# -lt 2 ]; then
        echo "--max-failures requires a number" >&2
        exit 2
      fi
      MAX_FAILURES="$2"
      shift 2
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

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required to read the PatchEval dataset." >&2
  exit 2
fi

if [ ! -f "$DATASET" ]; then
  echo "Dataset not found: $DATASET" >&2
  exit 2
fi

if ! [[ "$JOBS" =~ ^[0-9]+$ ]] || [ "$JOBS" -lt 1 ]; then
  echo "--jobs must be a positive integer." >&2
  exit 2
fi

if [ -n "$LIMIT" ] && { ! [[ "$LIMIT" =~ ^[0-9]+$ ]] || [ "$LIMIT" -lt 1 ]; }; then
  echo "--limit must be a positive integer." >&2
  exit 2
fi

if [ -n "$MAX_FAILURES" ] && { ! [[ "$MAX_FAILURES" =~ ^[0-9]+$ ]] || [ "$MAX_FAILURES" -lt 1 ]; }; then
  echo "--max-failures must be a positive integer." >&2
  exit 2
fi

if [ "$STOP_ON_FAILURE" -eq 1 ] && [ -z "$MAX_FAILURES" ]; then
  MAX_FAILURES=1
fi

PYTHON_BIN="${PYTHON_BIN:-python}"
RUN_PATCHEVAL=("$PYTHON_BIN" -m scripts.patcheval.run_patcheval)

contains() {
  local needle="$1"
  shift
  local item
  for item in "$@"; do
    if [ "$item" = "$needle" ]; then
      return 0
    fi
  done
  return 1
}

shell_join() {
  local out=""
  local arg
  for arg in "$@"; do
    printf -v arg '%q' "$arg"
    out="${out}${out:+ }${arg}"
  done
  printf '%s' "$out"
}

experiment_specs() {
  local cve="$1"
  printf '%s|%s|%s\n' "$cve" "end-to-end-default" ""
  printf '%s|%s|%s\n' "$cve" "end-to-end-single-agent" "--single-agent"
  printf '%s|%s|%s\n' "$cve" "end-to-end-two-stage" "--two-stage"
  printf '%s|%s|%s\n' "$cve" "location-oracle-default" "--location-oracle"
  printf '%s|%s|%s\n' "$cve" "location-oracle-single-agent" "--single-agent --location-oracle"
  printf '%s|%s|%s\n' "$cve" "location-oracle-two-stage" "--two-stage --location-oracle"
}

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

experiment_status() {
  local cve="$1"
  local variant="$2"
  local experiment_name="${cve}-${variant}"
  local out_dir="$REPO_ROOT/.agent-workspace-patcheval-${cve}-${TAG}"
  local link_path="$out_dir/$experiment_name"
  local target=""
  local run_dir=""
  local exit_code=""
  local patch_path=""
  local patch_bytes=""

  if [ ! -e "$out_dir" ]; then
    printf 'missing-workspace'
    return 0
  fi

  if [ ! -d "$out_dir" ]; then
    printf 'blocked-workspace'
    return 0
  fi

  if [ ! -e "$link_path" ]; then
    printf 'missing-symlink'
    return 0
  fi

  if [ ! -L "$link_path" ]; then
    printf 'blocked-non-symlink'
    return 0
  fi

  target="$(readlink "$link_path")"
  run_dir="$out_dir/$target"
  if [ ! -d "$run_dir" ]; then
    printf 'missing-target'
    return 0
  fi

  if [ ! -f "$run_dir/exit-code.txt" ]; then
    printf 'missing-exit-code'
    return 0
  fi

  exit_code="$(tr -d '[:space:]' < "$run_dir/exit-code.txt")"
  if [ "$exit_code" != "0" ]; then
    printf 'exit-%s' "$exit_code"
    return 0
  fi

  patch_path="$(first_workspace_patch "$run_dir")"
  if [ -z "$patch_path" ]; then
    printf 'missing-patch'
    return 0
  fi

  patch_bytes="$(wc -c < "$patch_path")"
  if [ "$REQUIRE_NONEMPTY_PATCH" -eq 1 ] && [ "$patch_bytes" -eq 0 ]; then
    printf 'empty-patch'
    return 0
  fi

  printf 'complete'
}

run_experiment() {
  local cve="$1"
  local variant="$2"
  local arg_string="$3"
  local experiment_name="${cve}-${variant}"
  local out_dir="$REPO_ROOT/.agent-workspace-patcheval-${cve}-${TAG}"
  local tmp_log_dir="$out_dir/_logs"
  local tmp_header="$tmp_log_dir/${experiment_name}.header.log"
  local tmp_stdout="$tmp_log_dir/${experiment_name}.stdout.log"
  local tmp_stderr="$tmp_log_dir/${experiment_name}.stderr.log"
  local tmp_runlog="$tmp_log_dir/${experiment_name}.run.log"
  local local_root=""
  local status=0
  local -a extra_args=()
  local -a cmd=()

  if [ -n "$arg_string" ]; then
    # arg_string is controlled by experiment_specs above.
    # shellcheck disable=SC2206
    extra_args=($arg_string)
  fi

  cmd=("${RUN_PATCHEVAL[@]}" --cve "$cve" --dataset "$DATASET" --output-dir "$out_dir")
  if [ "${#extra_args[@]}" -gt 0 ]; then
    cmd+=("${extra_args[@]}")
  fi

  mkdir -p "$out_dir" "$tmp_log_dir"
  echo "[$(date -u +%H:%M:%SZ)] START $experiment_name"

  {
    echo "EXPERIMENT=$experiment_name"
    echo "CVE=$cve"
    echo "DATASET=$DATASET"
    echo "OUT=$out_dir"
    echo "COMMAND=$(shell_join "${cmd[@]}")"
    echo
  } > "$tmp_header"

  "${cmd[@]}" > "$tmp_stdout" 2> "$tmp_stderr"
  status=$?

  local_root="$(grep -m1 '^LOCAL_ROOT=' "$tmp_stdout" | cut -d= -f2-)"

  if [ -n "$local_root" ] && [ -d "$local_root" ]; then
    mkdir -p "$local_root/logs"
    mv "$tmp_stdout" "$local_root/logs/run.stdout.log"
    mv "$tmp_stderr" "$local_root/logs/run.stderr.log"

    {
      cat "$tmp_header"
      echo "EXIT_CODE=$status"
      echo
      echo "===== STDERR (diagnostics) ====="
      perl -pe 's/\e\[[0-9;]*[A-Za-z]//g' "$local_root/logs/run.stderr.log"
      echo
      echo "===== STDOUT (metadata) ====="
      grep -E '^(LOCAL_ROOT|WORKFLOW_RESULT|PATCH_JSON)=' "$local_root/logs/run.stdout.log" || true
    } > "$tmp_runlog"
    mv "$tmp_runlog" "$local_root/logs/run.log"
    rm -f "$tmp_header"

    printf '%s\n' "$experiment_name" > "$local_root/experiment-name.txt"
    printf '%s\n' "$status" > "$local_root/exit-code.txt"
    ln -sfn "$(basename "$local_root")" "$out_dir/$experiment_name"

    if [ "$status" -eq 0 ]; then
      echo "[$(date -u +%H:%M:%SZ)] DONE  $experiment_name -> $(basename "$local_root")"
    else
      echo "[$(date -u +%H:%M:%SZ)] FAIL  $experiment_name -> $(basename "$local_root") exit=$status"
    fi
  else
    cat "$tmp_header" "$tmp_stderr" "$tmp_stdout" > "$tmp_log_dir/${experiment_name}.log"
    rm -f "$tmp_header" "$tmp_stdout" "$tmp_stderr" "$tmp_runlog"
    printf '%s\n' "$status" > "$tmp_log_dir/${experiment_name}.exit-code"
    echo "Could not resolve LOCAL_ROOT for $experiment_name; log left at $tmp_log_dir/${experiment_name}.log" >&2
    echo "[$(date -u +%H:%M:%SZ)] FAIL  $experiment_name exit=$status"
  fi

  return "$status"
}

mapfile -t ALL_CVES < <(jq -r '.[].cve_id' "$DATASET")

QUEUE=()
complete_count=0
queued_count=0
skipped_incomplete_count=0
blocked_count=0

for cve in "${ALL_CVES[@]}"; do
  if [ "${#ONLY[@]}" -gt 0 ] && ! contains "$cve" "${ONLY[@]}"; then
    continue
  fi
  if contains "$cve" "${EXCLUDE[@]}"; then
    continue
  fi

  while IFS='|' read -r spec_cve variant arg_string; do
    status="$(experiment_status "$spec_cve" "$variant")"
    case "$status" in
      complete)
        complete_count=$((complete_count + 1))
        ;;
      blocked-*)
        blocked_count=$((blocked_count + 1))
        printf 'SKIP %s\t%s\t%s\n' "$status" "$spec_cve" "$variant" >&2
        ;;
      exit-*|missing-target|missing-exit-code|missing-patch|empty-patch)
        if [ "$RESUME_INCOMPLETE" -eq 1 ]; then
          QUEUE+=("${spec_cve}|${variant}|${arg_string}|${status}")
          queued_count=$((queued_count + 1))
        else
          skipped_incomplete_count=$((skipped_incomplete_count + 1))
          printf 'SKIP %s\t%s\t%s\n' "$status" "$spec_cve" "$variant" >&2
        fi
        ;;
      missing-workspace|missing-symlink)
        QUEUE+=("${spec_cve}|${variant}|${arg_string}|${status}")
        queued_count=$((queued_count + 1))
        ;;
      *)
        blocked_count=$((blocked_count + 1))
        printf 'SKIP unknown:%s\t%s\t%s\n' "$status" "$spec_cve" "$variant" >&2
        ;;
    esac
  done < <(experiment_specs "$cve")
done

if [ -n "$LIMIT" ] && [ "${#QUEUE[@]}" -gt "$LIMIT" ]; then
  QUEUE=("${QUEUE[@]:0:$LIMIT}")
fi

echo "PatchEval experiment pool"
echo "Repo: $REPO_ROOT"
echo "Dataset: $DATASET"
echo "Tag: $TAG"
echo "Jobs: $JOBS"
echo "Complete experiments: $complete_count"
echo "Queued experiments before limit: $queued_count"
echo "Skipped incomplete experiments: $skipped_incomplete_count"
echo "Blocked experiments: $blocked_count"
echo "To run: ${#QUEUE[@]}"

if [ "${#QUEUE[@]}" -eq 0 ]; then
  echo "Nothing to run."
  exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo
  echo "Queued commands:"
  for spec in "${QUEUE[@]}"; do
    IFS='|' read -r cve variant arg_string reason <<< "$spec"
    out_dir="$REPO_ROOT/.agent-workspace-patcheval-${cve}-${TAG}"
    cmd=("${RUN_PATCHEVAL[@]}" --cve "$cve" --dataset "$DATASET" --output-dir "$out_dir")
    if [ -n "$arg_string" ]; then
      # shellcheck disable=SC2206
      extra_args=($arg_string)
      cmd+=("${extra_args[@]}")
    fi
    printf '  # %s %s (%s)\n' "$cve" "$variant" "$reason"
    printf '  %s\n' "$(shell_join "${cmd[@]}")"
  done
  exit 0
fi

MANIFEST_DIR="$REPO_ROOT/.patcheval-batch-manifests"
RUN_LABEL="$(date -u +%Y%m%dT%H%M%SZ)"
MANIFEST="$MANIFEST_DIR/experiment-pool-${TAG}-${RUN_LABEL}.tsv"
mkdir -p "$MANIFEST_DIR"
printf 'timestamp\tcve\tvariant\tbefore_status\tpid\n' > "$MANIFEST"
echo "Manifest: $MANIFEST"

overall=0
stop_launching=0
failure_count=0

wait_for_one() {
  if ! wait -n; then
    overall=1
    failure_count=$((failure_count + 1))
    if [ -n "$MAX_FAILURES" ] && [ "$failure_count" -ge "$MAX_FAILURES" ]; then
      echo "Failure threshold reached: $failure_count/$MAX_FAILURES. Not launching new experiments." >&2
      stop_launching=1
    fi
  fi
}

for spec in "${QUEUE[@]}"; do
  if [ "$stop_launching" -eq 1 ]; then
    break
  fi

  while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do
    wait_for_one
    if [ "$stop_launching" -eq 1 ]; then
      break
    fi
  done

  if [ "$stop_launching" -eq 1 ]; then
    break
  fi

  IFS='|' read -r cve variant arg_string reason <<< "$spec"
  run_experiment "$cve" "$variant" "$arg_string" &
  pid=$!
  printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$cve" "$variant" "$reason" "$pid" >> "$MANIFEST"
done

while [ "$(jobs -rp | wc -l)" -gt 0 ]; do
  wait_for_one
done

echo
echo "Experiment pool complete. Manifest: $MANIFEST"
if [ "$failure_count" -gt 0 ]; then
  echo "Failures observed: $failure_count"
fi
exit "$overall"
