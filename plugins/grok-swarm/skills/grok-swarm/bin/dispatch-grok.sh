#!/usr/bin/env bash
# dispatch-grok.sh — encode grok-swarm Mode A/B dispatch (no background &)
#
# CRITICAL (2026-07-09 hermestrader): never rely on `grok --cwd REPO --worktree NAME`
# alone to isolate builders. That flag can leave the session on MAIN; the builder
# guard then blocks with TOP==MAIN. Mode A always:
#   1) ensure a git worktree under ~/.grok/worktrees/repos-<repo>/<name>
#   2) launch grok with process cwd = that worktree (same as Mode B)
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  dispatch-grok.sh --mode new --repo REPO --worktree NAME --base REF \
    --agent "Builder N" --prompt-file PATH --log PATH [--task TASK_ID] [--print-only]

  dispatch-grok.sh --mode existing --worktree-path WT_PATH \
    --agent "Builder N" --prompt-file PATH --log PATH [--task TASK_ID] [--print-only]

Modes:
  new      Mode A — PRE-CREATE git worktree under ~/.grok/worktrees/repos-<repo>/<NAME>
                   on branch swarm/<NAME> at --base, then launch grok INSIDE that path
                   (no grok --worktree flag — isolation is process cwd).
  existing Mode B — shell must start in worktree; omit --cwd and --worktree

Options:
  --task ID      Swarm task id (or SWARM_TASK_ID). Auto-records dispatch + promotes
                 task → building as soon as grok starts (fixes dashboard lag).
  --no-auto-record  Disable auto dispatch record even if --task is set
  --print-only   Print the ensure + grok plan without running
  --model M      Default: bin/model-pin.env worker key (override GROK_SWARM_WORKER_MODEL)
  --effort L     low|medium|high|xhigh|max. Default from --agent role:
                   Scout* → low; Builder* → medium;
                   Reviewer*/Visual*/Logger*/Coordinator* → high
                 Override: GROK_SWARM_EFFORT or --effort
  --help         Show this help

After worktree create: copies env/credentials from MAIN (.env.local etc.) via worktree-seed.json.
Auto-record (when --task set): \`swarm dispatch record\` with real grok PID before wait —
dashboard shows Building/live runs immediately (not after the coordinator's next thought).
Post-flight (coordinator): still verify isolation + log growing; capture sessionId when known.
EOF
}

MODE=""
REPO=""
WORKTREE=""
BASE=""
WT_PATH=""
AGENT=""
PROMPT_FILE=""
LOG_FILE=""
_PIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/model-pin.env"
if [[ -f "$_PIN" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$_PIN"
  set +a
fi
MODEL="${GROK_SWARM_WORKER_MODEL:-${GROK_SWARM_WORKER_MODEL_DEFAULT:-}}"
if [[ -z "$MODEL" ]]; then
  echo "model pin missing ($_PIN)" >&2
  exit 1
fi
EFFORT_EXPLICIT=""
PRINT_ONLY=0
TASK_ID="${SWARM_TASK_ID:-}"
AUTO_RECORD=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --worktree) WORKTREE="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --worktree-path) WT_PATH="$2"; shift 2 ;;
    --agent) AGENT="$2"; shift 2 ;;
    --prompt-file) PROMPT_FILE="$2"; shift 2 ;;
    --log) LOG_FILE="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --effort) EFFORT_EXPLICIT="$2"; shift 2 ;;
    --task) TASK_ID="$2"; shift 2 ;;
    --no-auto-record) AUTO_RECORD=0; shift ;;
    --print-only) PRINT_ONLY=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

[[ -n "$MODE" ]] || { echo "Missing --mode (new|existing)" >&2; exit 1; }
[[ -n "$AGENT" ]] || { echo "Missing --agent" >&2; exit 1; }
[[ -n "$PROMPT_FILE" ]] || { echo "Missing --prompt-file" >&2; exit 1; }
[[ -f "$PROMPT_FILE" ]] || { echo "Prompt file not found: $PROMPT_FILE" >&2; exit 1; }
[[ -n "$LOG_FILE" ]] || { echo "Missing --log" >&2; exit 1; }

# Strip HTML comments from prompt file before dispatch (harmless if template already clean)
# Removes <!-- ... --> blocks including multiline; keeps prompt self-contained and avoids Grok noise.
if grep -q '<!--' "$PROMPT_FILE" 2>/dev/null; then
  _tmp_prompt="${PROMPT_FILE}.stripped.$$"
  # perl is portable on macOS/Linux; fallback to sed if unavailable
  if command -v perl >/dev/null 2>&1; then
    perl -0777 -pe 's/<!--.*?-->//gs' "$PROMPT_FILE" > "$_tmp_prompt"
  else
    sed '/<!--/,/-->/d' "$PROMPT_FILE" > "$_tmp_prompt"
  fi
  # Only replace if stripping left non-empty content
  if [[ -s "$_tmp_prompt" ]]; then
    PROMPT_FILE="$_tmp_prompt"
    echo "# prompt: stripped HTML comments → $PROMPT_FILE" >&2
  else
    rm -f "$_tmp_prompt"
  fi
fi

# --- effort by role ----------------------------------------------------------
# Scout → low (cheap inventory). Builder → medium (implementation).
# Reviewer / Visual / Logger / Coordinator → high (judgment / synthesis).
default_effort_for_agent() {
  local a
  a=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case "$a" in
    *scout*) echo low ;;
    *review*|*visual*|*logger*|*coord*) echo high ;;
    *builder*|*worker*|*fix*) echo medium ;;
    *) echo medium ;;
  esac
}

if [[ -n "${EFFORT_EXPLICIT}" ]]; then
  EFFORT="$EFFORT_EXPLICIT"
elif [[ -n "${GROK_SWARM_EFFORT:-}" ]]; then
  EFFORT="$GROK_SWARM_EFFORT"
else
  EFFORT="$(default_effort_for_agent "$AGENT")"
fi

# --- role flags (do not pass --check or --best-of-n; see reference.md header) ---
WORKER_MAX_TURNS="${GROK_SWARM_WORKER_MAX_TURNS:-100}"
WORKER_SCHEMA_MODE="${GROK_SWARM_WORKER_JSON_SCHEMA_MODE:-off}"
# Back-compat: GROK_SWARM_WORKER_JSON_SCHEMA=1 → replace
if [[ "${GROK_SWARM_WORKER_JSON_SCHEMA:-0}" == "1" && "$WORKER_SCHEMA_MODE" == "off" ]]; then
  WORKER_SCHEMA_MODE=replace
fi
SANDBOX_MODE="${GROK_SWARM_SANDBOX:-off}"
DISABLE_WEB="${GROK_SWARM_DISABLE_WEB_SEARCH:-0}"

role_kind_for_agent() {
  local a
  a=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case "$a" in
    *scout*) echo scout ;;
    *visual*) echo visual ;;
    *review*) echo reviewer ;;
    *logger*) echo logger ;;
    *builder*|*worker*|*fix*) echo builder ;;
    *) echo builder ;;
  esac
}

ROLE_KIND="$(role_kind_for_agent "$AGENT")"
# Resolve skill root even when dispatch-grok.sh is reached via symlink
SCRIPT_PATH="${BASH_SOURCE[0]}"
if command -v realpath >/dev/null 2>&1; then
  SCRIPT_PATH="$(realpath "$SCRIPT_PATH")"
elif [[ -L "$SCRIPT_PATH" ]]; then
  SCRIPT_PATH="$(readlink "$SCRIPT_PATH" 2>/dev/null || echo "$SCRIPT_PATH")"
fi
SKILL_ROOT="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"
SCHEMA_FILE="$SKILL_ROOT/templates/worker-done.schema.json"

# Mutates GROK_CMD after base flags are set — call once after GROK_CMD=(...)
append_role_cli_flags() {
  GROK_CMD+=(--max-turns "$WORKER_MAX_TURNS")
  # Grok 1.0.5 dropped top-level --no-memory (not in `grok --help`). Do not pass it.

  case "$ROLE_KIND" in
    scout|reviewer|logger)
      # Tightened 1.0.0+: use allowlist for true read-only (fallback to disallow if --tools unsupported)
      # Env GROK_SWARM_REVIEWER_STRICT=0 to keep legacy --disallowed-tools only
      if [[ "${GROK_SWARM_REVIEWER_STRICT:-1}" != "0" ]]; then
        GROK_CMD+=(--tools "read_file,grep,list_dir")
      else
        GROK_CMD+=(--disallowed-tools "search_replace")
      fi
      if [[ "$SANDBOX_MODE" != "off" ]]; then
        GROK_CMD+=(--sandbox read-only)
      fi
      ;;
    visual)
      # Shell needed for agent-browser; block file edits only
      GROK_CMD+=(--disallowed-tools "search_replace")
      if [[ "$SANDBOX_MODE" == "workspace" ]]; then
        GROK_CMD+=(--sandbox workspace)
      fi
      ;;
    builder)
      if [[ "$SANDBOX_MODE" == "workspace" ]]; then
        GROK_CMD+=(--sandbox workspace)
      fi
      if [[ "$DISABLE_WEB" == "1" ]]; then
        GROK_CMD+=(--disable-web-search)
      fi
      if [[ "$WORKER_SCHEMA_MODE" == "replace" && -f "$SCHEMA_FILE" ]]; then
        local new_cmd=()
        local i
        for ((i=0; i<${#GROK_CMD[@]}; i++)); do
          if [[ "${GROK_CMD[$i]}" == "--output-format" ]]; then
            ((i++)) || true
            continue
          fi
          new_cmd+=("${GROK_CMD[$i]}")
        done
        GROK_CMD=("${new_cmd[@]}")
        GROK_CMD+=(--output-format json --json-schema "$SCHEMA_FILE")
      fi
      ;;
  esac
}

# --- helpers -----------------------------------------------------------------

repo_basename() {
  # /Users/x/repos/hermestrader -> hermestrader
  basename "${1%/}"
}

default_wt_path() {
  local repo="$1" name="$2"
  local root="${GROK_WORKTREES_ROOT:-$HOME/.grok/worktrees}"
  echo "${root}/repos-$(repo_basename "$repo")/${name}"
}

assert_isolated_worktree() {
  # $1 = WT_PATH, $2 = MAIN_REPO
  local wt="$1" main_repo="$2"
  local top main
  top=$(git -C "$wt" rev-parse --show-toplevel 2>/dev/null) || {
    echo "ERROR: $wt is not a git worktree" >&2
    exit 1
  }
  main=$(git -C "$main_repo" rev-parse --show-toplevel 2>/dev/null) || {
    echo "ERROR: $main_repo is not a git repo" >&2
    exit 1
  }
  # Resolve physical paths for comparison
  top=$(cd "$top" && pwd -P)
  main=$(cd "$main" && pwd -P)
  if [[ "$top" == "$main" ]]; then
    echo "ERROR: worktree guard TOP==MAIN ($top). Refusing to dispatch on main repo." >&2
    echo "  Expected isolated path under ~/.grok/worktrees/…" >&2
    exit 1
  fi
  case "$top" in
    */.grok/worktrees/*) ;;
    *)
      # Allow non-default locations if TOP != MAIN (tests / custom layouts)
      echo "# warn: worktree not under ~/.grok/worktrees (TOP=$top)" >&2
      ;;
  esac
}

ensure_git_worktree() {
  # $1=REPO $2=WORKTREE_NAME $3=BASE $4=WT_PATH
  local repo="$1" name="$2" base="$3" wt="$4"
  local branch="swarm/${name}"
  local parent
  parent=$(dirname "$wt")
  mkdir -p "$parent"

  if [[ -d "$wt" ]]; then
    if git -C "$wt" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      assert_isolated_worktree "$wt" "$repo"
      echo "# reuse existing worktree: $wt" >&2
      return 0
    fi
    echo "ERROR: path exists but is not a git worktree: $wt" >&2
    exit 1
  fi

  # Prefer creating a new branch at base; if branch exists, attach worktree to it.
  if git -C "$repo" show-ref --verify --quiet "refs/heads/${branch}"; then
    git -C "$repo" worktree add "$wt" "$branch" >&2
  else
    git -C "$repo" worktree add -b "$branch" "$wt" "$base" >&2
  fi
  assert_isolated_worktree "$wt" "$repo"
  echo "# created worktree: $wt (branch $branch @ $base)" >&2
}


seed_worktree_env() {
  # $1=MAIN_REPO $2=WT_PATH — copy gitignored env/credentials so the app works in the worktree
  local repo="$1" wt="$2"
  local seed_file skill_default skill_root
  skill_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  skill_default="${skill_root}/templates/worktree-seed.default.json"
  seed_file=""
  if [[ -f "${repo}/.grok-swarm/worktree-seed.json" ]]; then
    seed_file="${repo}/.grok-swarm/worktree-seed.json"
  elif [[ -f "${repo}/.grok-swarm/mega/worktree-seed.json" ]]; then
    seed_file="${repo}/.grok-swarm/mega/worktree-seed.json"
  elif [[ -f "$skill_default" ]]; then
    seed_file="$skill_default"
  else
    echo "# seed: no seed manifest found; skipping env copy" >&2
    return 0
  fi
  echo "# seed: using $seed_file → $wt" >&2
  # Prefer node for JSON; fallback to a tiny python/jq-less list of common files
  if command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("fs");
      const path = require("path");
      const repo = process.argv[1];
      const wt = process.argv[2];
      const seedFile = process.argv[3];
      let seed;
      try { seed = JSON.parse(fs.readFileSync(seedFile, "utf8")); }
      catch (e) { console.error("# seed: invalid JSON " + seedFile); process.exit(0); }
      const files = Array.isArray(seed.copy_from_main) ? seed.copy_from_main : [];
      const required = new Set(Array.isArray(seed.required) ? seed.required : []);
      let missingRequired = [];
      for (const rel of files) {
        if (!rel || rel.includes("..")) continue;
        const src = path.join(repo, rel);
        const dest = path.join(wt, rel);
        if (!fs.existsSync(src)) {
          if (required.has(rel)) missingRequired.push(rel);
          else console.error("# seed: skip missing " + rel);
          continue;
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        try {
          const st = fs.statSync(src);
          fs.chmodSync(dest, st.mode);
        } catch (_) {}
        console.error("# seed: copied " + rel);
      }
      if (missingRequired.length) {
        console.error("ERROR: required seed files missing on MAIN: " + missingRequired.join(", "));
        process.exit(2);
      }
    ' "$repo" "$wt" "$seed_file" || {
      local ec=$?
      if [[ $ec -eq 2 ]]; then exit 2; fi
      echo "# seed: node seed failed (ec=$ec); continuing" >&2
    }
  else
    for rel in .env.local .env playwright/.auth/user.json; do
      if [[ -f "${repo}/${rel}" ]]; then
        mkdir -p "$(dirname "${wt}/${rel}")"
        cp -a "${repo}/${rel}" "${wt}/${rel}"
        echo "# seed: copied $rel" >&2
      fi
    done
  fi
}

# --- build command -----------------------------------------------------------

GROK_CMD=()
MAIN_FOR_GUARD=""

case "$MODE" in
  new)
    [[ -n "$REPO" ]] || { echo "Mode new requires --repo" >&2; exit 1; }
    [[ -n "$WORKTREE" ]] || { echo "Mode new requires --worktree" >&2; exit 1; }
    [[ -n "$BASE" ]] || { echo "Mode new requires --base" >&2; exit 1; }
    if [[ "$REPO" == *"/.grok/worktrees/"* ]]; then
      echo "ERROR: --repo must be the MAIN repo, not a worktree path (~/.grok/worktrees/...)." >&2
      echo "  Use --mode existing --worktree-path for continuing an existing worktree." >&2
      exit 1
    fi
    WT_PATH=$(default_wt_path "$REPO" "$WORKTREE")
    MAIN_FOR_GUARD="$REPO"
    # Isolation via process cwd ONLY — never pass --worktree to grok on Mode A
    GROK_CMD=(
      grok --prompt-file "$PROMPT_FILE"
      -m "$MODEL"
      --effort "$EFFORT"
      --always-approve
      --no-subagents
      --output-format streaming-json
    )
    append_role_cli_flags
    ;;
  existing)
    [[ -n "$WT_PATH" ]] || { echo "Mode existing requires --worktree-path" >&2; exit 1; }
    [[ -d "$WT_PATH" ]] || { echo "Worktree path not found: $WT_PATH" >&2; exit 1; }
    # Infer main for guard if possible (parent of .git/worktrees)
    MAIN_FOR_GUARD=""
    GROK_CMD=(
      grok --prompt-file "$PROMPT_FILE"
      -m "$MODEL"
      --effort "$EFFORT"
      --always-approve
      --no-subagents
      --output-format streaming-json
    )
    append_role_cli_flags
    ;;
  *)
    echo "Invalid --mode: $MODE (use new or existing)" >&2
    exit 1
    ;;
esac

# Print human-readable command for coordinator logs
printf '# dispatch-grok.sh %s role=%s effort=%s model=%s max-turns=%s\n' \
  "$MODE" "$ROLE_KIND" "$EFFORT" "$MODEL" "$WORKER_MAX_TURNS"
printf 'export SWARM_AGENT_NAME=%q\n' "$AGENT"
if [[ -n "${SWARM_ID:-}" ]]; then
  printf 'export SWARM_ID=%q\n' "$SWARM_ID"
fi
if [[ "$MODE" == "new" ]]; then
  printf '# ensure git worktree: REPO=%q NAME=%q BASE=%q → WT=%q\n' \
    "$REPO" "$WORKTREE" "$BASE" "$WT_PATH"
  printf '# isolation: process cwd = worktree (NO grok --worktree flag)\n'
fi
printf 'cd %q && ' "$WT_PATH"
printf '%q ' "${GROK_CMD[@]}"
printf '> %q 2>&1\n' "$LOG_FILE"
echo "# Harness tip: Cursor Shell block_until_ms=0, NO trailing &. working_directory=$WT_PATH"
echo "# WORKTREE_PATH=$WT_PATH"
if [[ -n "$TASK_ID" ]]; then
  echo "# TASK_ID=$TASK_ID auto_record=$AUTO_RECORD"
fi

if [[ "$PRINT_ONLY" -eq 1 ]]; then
  exit 0
fi

export SWARM_AGENT_NAME="$AGENT"
export GROK_SWARM_MUTE_CHIME=1
if [[ -n "${SWARM_ID:-}" ]]; then
  export SWARM_ID
fi

if [[ "$MODE" == "new" ]]; then
  ensure_git_worktree "$REPO" "$WORKTREE" "$BASE" "$WT_PATH"
  seed_worktree_env "$REPO" "$WT_PATH"
elif [[ -n "$MAIN_FOR_GUARD" ]]; then
  assert_isolated_worktree "$WT_PATH" "$MAIN_FOR_GUARD"
else
  # Mode existing: still refuse if TOP looks like a bare clone of main with no
  # worktree marker — at least require .git is a file (linked worktree) or path
  # differs from common main locations. Soft check:
  if [[ -d "$WT_PATH/.git" && ! -f "$WT_PATH/.git" ]]; then
    # full repo checkout — warn only if path is not under .grok/worktrees
    case "$WT_PATH" in
      */.grok/worktrees/*) ;;
      *)
        echo "ERROR: --worktree-path looks like a full clone (directory .git), not a linked worktree: $WT_PATH" >&2
        echo "  Mode B must run inside an isolated worktree, never the main checkout." >&2
        exit 1
        ;;
    esac
  fi
fi

# Mode existing: re-seed if MAIN can be resolved from worktree
if [[ "$MODE" == "existing" ]]; then
  COMMON=$(git -C "$WT_PATH" rev-parse --path-format=absolute --git-common-dir 2>/dev/null \
    || git -C "$WT_PATH" rev-parse --git-common-dir 2>/dev/null \
    || true)
  if [[ -n "$COMMON" ]]; then
    # common dir is typically MAIN/.git (absolute or relative)
    if [[ "$COMMON" != /* ]]; then
      COMMON=$(cd "$WT_PATH" && cd "$COMMON" 2>/dev/null && pwd -P || echo "$COMMON")
    fi
    if [[ "$COMMON" == *.git ]]; then
      MAIN_FROM_WT=$(cd "$(dirname "$COMMON")" && pwd -P)
    else
      # some git versions return the common git dir without trailing .git semantics
      MAIN_FROM_WT=$(cd "$COMMON/.." 2>/dev/null && pwd -P || true)
    fi
    if [[ -n "$MAIN_FROM_WT" && -d "$MAIN_FROM_WT" ]] && \
       { [[ -f "$MAIN_FROM_WT/.git" ]] || [[ -d "$MAIN_FROM_WT/.git" ]]; }; then
      seed_worktree_env "$MAIN_FROM_WT" "$WT_PATH"
    fi
  fi
fi

cd "$WT_PATH"
# Final hard guard immediately before launch
TOP_NOW=$(git rev-parse --show-toplevel)
TOP_NOW=$(cd "$TOP_NOW" && pwd -P)
if [[ -n "${REPO:-}" ]]; then
  MAIN_NOW=$(cd "$(git -C "$REPO" rev-parse --show-toplevel)" && pwd -P)
  if [[ "$TOP_NOW" == "$MAIN_NOW" ]]; then
    echo "ERROR: pre-exec guard TOP==MAIN ($TOP_NOW). Abort." >&2
    exit 1
  fi
fi

# Launch as child (not exec) so we can capture PID and auto-record for the dashboard
# before waiting — kills the "all 5 Queued" lag while worktrees were already running.
: >> "$LOG_FILE" 2>/dev/null || : > "$LOG_FILE"
"${GROK_CMD[@]}" > "$LOG_FILE" 2>&1 &
GROK_PID=$!
echo "# GROK_PID=$GROK_PID" >&2
echo "# WORKTREE_PATH=$WT_PATH" >&2

auto_record_dispatch() {
  # Best-effort: never kill a healthy builder because board write failed.
  if [[ "$AUTO_RECORD" -ne 1 || -z "$TASK_ID" ]]; then
    return 0
  fi
  local swarm_bin main_repo wt_name rec_args
  swarm_bin="$SKILL_ROOT/bin/swarm"
  if [[ ! -x "$swarm_bin" ]]; then
    swarm_bin="$SKILL_ROOT/bin/swarm.cjs"
  fi
  main_repo="${REPO:-}"
  if [[ -z "$main_repo" && -n "${MAIN_FROM_WT:-}" ]]; then
    main_repo="$MAIN_FROM_WT"
  fi
  if [[ -z "$main_repo" ]]; then
    # Infer MAIN from worktree common git dir
    local common
    common=$(git -C "$WT_PATH" rev-parse --path-format=absolute --git-common-dir 2>/dev/null \
      || git -C "$WT_PATH" rev-parse --git-common-dir 2>/dev/null || true)
    if [[ -n "$common" ]]; then
      if [[ "$common" != /* ]]; then
        common=$(cd "$WT_PATH" && cd "$common" 2>/dev/null && pwd -P || echo "$common")
      fi
      if [[ "$common" == *.git ]]; then
        main_repo=$(cd "$(dirname "$common")" && pwd -P)
      else
        main_repo=$(cd "$common/.." 2>/dev/null && pwd -P || true)
      fi
    fi
  fi
  wt_name="${WORKTREE:-}"
  if [[ -z "$wt_name" ]]; then
    wt_name=$(basename "$WT_PATH")
  fi
  if [[ ! -e "$swarm_bin" ]]; then
    echo "# auto-record: swarm bin missing at $swarm_bin — skip" >&2
    return 0
  fi
  if [[ -z "$main_repo" || ! -d "$main_repo" ]]; then
    echo "# auto-record: could not resolve MAIN repo — skip" >&2
    return 0
  fi
  rec_args=(
    dispatch record
    --task "$TASK_ID"
    --agent "$AGENT"
    --worktree "$wt_name"
    --worktree-path "$WT_PATH"
    --log "$LOG_FILE"
    --pid "$GROK_PID"
    --note "auto-record by dispatch-grok.sh"
  )
  if [[ -n "${BASE:-}" ]]; then
    rec_args+=(--base "$BASE")
  fi
  echo "# auto-record: task=$TASK_ID pid=$GROK_PID wt=$wt_name main=$main_repo" >&2
  (
    export SWARM_AGENT_NAME="${SWARM_AGENT_NAME:-$AGENT}"
    if [[ -n "${SWARM_ID:-}" ]]; then export SWARM_ID; fi
    # Must run from MAIN so findWorkspace locates .grok-swarm/ (worktree often lacks it)
    cd "$main_repo" || exit 0
    if [[ -x "$SKILL_ROOT/bin/swarm" ]]; then
      "$SKILL_ROOT/bin/swarm" --cwd "$main_repo" "${rec_args[@]}"
    else
      node "$SKILL_ROOT/bin/swarm.cjs" --cwd "$main_repo" "${rec_args[@]}"
    fi
  ) 2>&1 | sed 's/^/# auto-record: /' >&2 || {
    echo "# auto-record: FAILED (builder still running) — coordinator must record manually" >&2
  }
}

auto_record_dispatch

# Wait for grok; propagate exit code (replaces former exec)
set +e
wait "$GROK_PID"
EC=$?
set -e
exit "$EC"
