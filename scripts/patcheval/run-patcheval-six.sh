#!/usr/bin/env bash
set -uo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/patcheval/run-patcheval-six.sh CVE-ID [options]

Runs the 3 x 2 PatchEval matrix for one CVE:
  - default workflow, end-to-end
  - default workflow, location oracle
  - two-stage workflow, end-to-end
  - two-stage workflow, location oracle
  - single-agent workflow, end-to-end
  - single-agent workflow, location oracle

Options:
  --dataset PATH     PatchEval enriched dataset JSON.
  --output-dir PATH  Output directory. Overrides --tag.
  --tag LABEL        Batch label used in the default output directory.
                    Defaults to the current UTC timestamp.
  -h, --help         Show this help.
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

if [ $# -lt 1 ]; then
  usage >&2
  exit 2
fi

CVE="$1"
shift

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
DATASET="$REPO_ROOT/PatchEval/patcheval/datasets/patcheval_runtime_subset_cleaned.json"
OUT=""
TAG=""

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
    --output-dir)
      if [ $# -lt 2 ]; then
        echo "--output-dir requires a path" >&2
        exit 2
      fi
      OUT="$2"
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

if [ -z "$OUT" ]; then
  if [ -z "$TAG" ]; then
    TAG="$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  OUT="$REPO_ROOT/.agent-workspace-patcheval-${CVE}-${TAG}"
fi

PYTHON_BIN="${PYTHON_BIN:-python}"
RUN_PATCHEVAL=("$PYTHON_BIN" -m scripts.patcheval.run_patcheval)

TMP_LOG_DIR="$OUT/_logs"
mkdir -p "$TMP_LOG_DIR"

run_exp() {
  local name="$1"
  shift

  local tmp_header="$TMP_LOG_DIR/${name}.header.log"
  local tmp_stdout="$TMP_LOG_DIR/${name}.stdout.log"
  local tmp_stderr="$TMP_LOG_DIR/${name}.stderr.log"
  local tmp_runlog="$TMP_LOG_DIR/${name}.run.log"
  local local_root=""
  local status=0

  echo "[$(date -u +%H:%M:%SZ)] START $name"

  {
    echo "EXPERIMENT=$name"
    echo "CVE=$CVE"
    echo "DATASET=$DATASET"
    echo "OUT=$OUT"
    echo "ARGS=$*"
    echo
  } > "$tmp_header"

  "${RUN_PATCHEVAL[@]}" \
    --cve "$CVE" \
    --dataset "$DATASET" \
    --output-dir "$OUT" \
    "$@" \
    >> "$tmp_stdout" 2>> "$tmp_stderr"
  status=$?

  local_root="$(grep -m1 '^LOCAL_ROOT=' "$tmp_stdout" | cut -d= -f2-)"

  if [ -n "$local_root" ] && [ -d "$local_root" ]; then
    mkdir -p "$local_root/logs"
    mv "$tmp_stdout" "$local_root/logs/run.stdout.log"
    mv "$tmp_stderr" "$local_root/logs/run.stderr.log"

    {
      cat "$tmp_header"
      echo "===== STDERR (diagnostics) ====="
      perl -pe 's/\e\[[0-9;]*[A-Za-z]//g' "$local_root/logs/run.stderr.log"
      echo
      echo "===== STDOUT (metadata) ====="
      grep -E '^(LOCAL_ROOT|WORKFLOW_RESULT|PATCH_JSON)=' "$local_root/logs/run.stdout.log" || true
    } > "$tmp_runlog"
    mv "$tmp_runlog" "$local_root/logs/run.log"
    rm -f "$tmp_header"

    printf '%s\n' "$name" > "$local_root/experiment-name.txt"
    printf '%s\n' "$status" > "$local_root/exit-code.txt"
    ln -sfn "$(basename "$local_root")" "$OUT/$name"
    if [ "$status" -eq 0 ]; then
      echo "[$(date -u +%H:%M:%SZ)] DONE  $name -> $(basename "$local_root")"
    else
      echo "[$(date -u +%H:%M:%SZ)] FAIL  $name -> $(basename "$local_root") exit=$status"
    fi
  else
    cat "$tmp_header" "$tmp_stderr" "$tmp_stdout" > "$TMP_LOG_DIR/${name}.log"
    rm -f "$tmp_header" "$tmp_stdout" "$tmp_stderr" "$tmp_runlog"
    printf '%s\n' "$status" > "$TMP_LOG_DIR/${name}.exit-code"
    echo "Could not resolve LOCAL_ROOT for $name; log left at $TMP_LOG_DIR/${name}.log" >&2
    echo "[$(date -u +%H:%M:%SZ)] FAIL  $name exit=$status"
  fi

  return "$status"
}

echo "Running PatchEval six-pack for $CVE"
echo "Output: $OUT"
echo "Temporary logs: $TMP_LOG_DIR"
echo "Logs move to <local-run>/logs/run.log after each experiment resolves LOCAL_ROOT."
echo

run_exp "${CVE}-end-to-end-default" &
pid_default_e2e=$!
run_exp "${CVE}-location-oracle-default" --location-oracle &
pid_default_location=$!

run_exp "${CVE}-end-to-end-two-stage" --two-stage &
pid_two_stage_e2e=$!
run_exp "${CVE}-location-oracle-two-stage" --two-stage --location-oracle &
pid_two_stage_location=$!

run_exp "${CVE}-end-to-end-single-agent" --single-agent &
pid_single_agent_e2e=$!
run_exp "${CVE}-location-oracle-single-agent" --single-agent --location-oracle &
pid_single_agent_location=$!

status=0
for pid in \
  "$pid_default_e2e" \
  "$pid_default_location" \
  "$pid_two_stage_e2e" \
  "$pid_two_stage_location" \
  "$pid_single_agent_e2e" \
  "$pid_single_agent_location"
do
  if ! wait "$pid"; then
    status=1
  fi
done

echo
echo "ALL DONE: $OUT"
echo "Experiment links:"
find "$OUT" -maxdepth 1 -type l -printf '  %f -> %l\n' | sort

exit "$status"
