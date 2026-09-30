#!/usr/bin/env bash
# run-coordinator.sh — launch the Grok CLI autonomous coordinator (no bare &)
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  run-coordinator.sh --repo REPO --prompt-file PATH --log PATH \
    [--model M] [--max-turns N] [--session ID] [--effort LEVEL] [--print-only]

Runs a long-lived headless Grok process as the swarm Coordinator.
Does NOT pass --no-subagents (coordinator needs shell + tools for swarm/git/dispatch).

Options:
  --repo PATH         Main repo root (required)
  --prompt-file PATH  Rendered coordinator prompt (required)
  --log PATH          streaming-json log file (required)
  --model M           Default: bin/model-pin.env coordinator key
  --max-turns N       Default: 500
  --session ID        Resume coordinator session with -r (Mode C for the coordinator itself)
  --effort LEVEL      Default: high
  --print-only        Print the grok command; do not execute
  --help              Show this help
EOF
}

REPO=""
PROMPT_FILE=""
LOG_FILE=""
_PIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/model-pin.env"
if [[ -f "$_PIN" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$_PIN"
  set +a
fi
MODEL="${GROK_SWARM_COORDINATOR_MODEL_DEFAULT:-}"
if [[ -z "$MODEL" ]]; then
  echo "model pin missing ($_PIN)" >&2
  exit 1
fi
MAX_TURNS="500"
SESSION=""
EFFORT="high"
PRINT_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --prompt-file) PROMPT_FILE="$2"; shift 2 ;;
    --log) LOG_FILE="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --max-turns) MAX_TURNS="$2"; shift 2 ;;
    --session) SESSION="$2"; shift 2 ;;
    --effort) EFFORT="$2"; shift 2 ;;
    --print-only) PRINT_ONLY=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

[[ -n "$REPO" ]] || { echo "Missing --repo" >&2; exit 1; }
[[ -d "$REPO" ]] || { echo "Repo not found: $REPO" >&2; exit 1; }
[[ -n "$PROMPT_FILE" ]] || { echo "Missing --prompt-file" >&2; exit 1; }
[[ -f "$PROMPT_FILE" ]] || { echo "Prompt file not found: $PROMPT_FILE" >&2; exit 1; }
[[ -n "$LOG_FILE" ]] || { echo "Missing --log" >&2; exit 1; }

if [[ "$REPO" == *"/.grok/worktrees/"* ]]; then
  echo "ERROR: --repo must be the MAIN repo, not a worktree path." >&2
  exit 1
fi

GROK_CMD=(
  grok --prompt-file "$PROMPT_FILE"
  --cwd "$REPO"
  -m "$MODEL"
  --always-approve
  --max-turns "$MAX_TURNS"
  --effort "$EFFORT"
  --output-format streaming-json
)

if [[ -n "$SESSION" ]]; then
  GROK_CMD+=(-r "$SESSION")
fi

printf '# run-coordinator.sh\n'
printf 'export SWARM_AGENT_NAME=Coordinator\n'
if [[ -n "${SWARM_ID:-}" ]]; then
  printf 'export SWARM_ID=%q\n' "$SWARM_ID"
fi
printf '%q ' "${GROK_CMD[@]}"
printf '> %q 2>&1\n' "$LOG_FILE"

if [[ "$PRINT_ONLY" -eq 1 ]]; then
  exit 0
fi

export SWARM_AGENT_NAME="Coordinator"
export GROK_SWARM_MUTE_CHIME=1
if [[ -n "${SWARM_ID:-}" ]]; then
  export SWARM_ID
fi

# Ensure log directory exists
mkdir -p "$(dirname "$LOG_FILE")"
# Truncate/create log so post-flight size checks are meaningful
: > "$LOG_FILE"

exec "${GROK_CMD[@]}" > "$LOG_FILE" 2>&1
