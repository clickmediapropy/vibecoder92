#!/usr/bin/env bash
# coordinator-guard.sh — mechanical checks before coordinator dispatches builders
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  coordinator-guard.sh --repo REPO [--expect-clean] [--expect-dispatches-running N]

Checks (exit non-zero on failure):
  --expect-clean (default on)  Main repo working tree must be clean, or only .grok-swarm/ changes
  --expect-dispatches-running N  Optional: exactly N dispatches with status running (via swarm CLI)

Coordinator must NOT dispatch the next builder wave when this script fails.
EOF
}

REPO=""
EXPECT_CLEAN=1
EXPECT_RUNNING=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --expect-clean) EXPECT_CLEAN=1; shift ;;
    --no-expect-clean) EXPECT_CLEAN=0; shift ;;
    --expect-dispatches-running) EXPECT_RUNNING="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

[[ -n "$REPO" ]] || { echo "Missing --repo" >&2; exit 1; }
[[ -d "$REPO" ]] || { echo "Repo not found: $REPO" >&2; exit 1; }

fail() {
  echo "coordinator-guard: $*" >&2
  exit 1
}

allowed_path() {
  local p="$1"
  [[ "$p" == .grok-swarm/* ]] || [[ "$p" == .grok-swarm ]]
}

if [[ "$EXPECT_CLEAN" -eq 1 ]]; then
  if ! git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    fail "not a git repository: $REPO"
  fi

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    status="${line:0:2}"
    path="${line:3}"
    if ! allowed_path "$path"; then
      fail "main repo dirty (disallowed path): $path (status: $status). Stash/commit or use --no-expect-clean with user approval."
    fi
  done < <(git -C "$REPO" status --porcelain)

  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    if ! allowed_path "$path"; then
      fail "staged changes outside .grok-swarm/: $path"
    fi
  done < <(git -C "$REPO" diff --cached --name-only 2>/dev/null || true)
fi

if [[ -n "$EXPECT_RUNNING" ]]; then
  SWARM_SH="$(dirname "$0")/swarm"
  SWARM_CJS="$(dirname "$0")/swarm.cjs"
  export SWARM_AGENT_NAME="${SWARM_AGENT_NAME:-Coordinator}"
  running_json=""
  if [[ -x "$SWARM_SH" ]]; then
    running_json="$(cd "$REPO" && SWARM_AGENT_NAME=Coordinator "$SWARM_SH" dispatch list --status running --json 2>/dev/null || echo '[]')"
  else
    running_json="$(cd "$REPO" && SWARM_AGENT_NAME=Coordinator node "$SWARM_CJS" dispatch list --status running --json 2>/dev/null || echo '[]')"
  fi
  count="$(node -e 'const j=JSON.parse(process.argv[1]||"[]"); console.log(Array.isArray(j)?j.length:0)' "$running_json" 2>/dev/null || echo 0)"
  if [[ "$count" != "$EXPECT_RUNNING" ]]; then
    fail "expected $EXPECT_RUNNING running dispatches, found $count"
  fi
fi

echo "coordinator-guard: OK ($REPO)"
