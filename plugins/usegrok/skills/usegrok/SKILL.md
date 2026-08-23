---
name: usegrok
description: Delegates planning, auditing, fixing, and any read/write coding task to the Grok CLI (`grok`) in headless print mode (`-p`). The current model acts only as orchestrator and verifier — crafts self-contained prompts, runs `grok -p`, and verifies the result. Use when the user says usegrok, "delegate to grok", "ask grok", or wants a single task run on Grok CLI.
---

# usegrok — Orchestrate the Grok CLI (`grok`)

`grok` is **xAI's** agentic coding CLI (Grok Build). When this skill is active, the current model is the **orchestrator only**. It MUST NOT plan, audit, fix, or implement directly. Every task involving code — planning, auditing, fixing, refactoring, building, testing — is delegated to `grok -p`.

This skill is **stack-agnostic**: it never assumes a language, framework, or toolchain. The target repo's own guidance files and check commands are discovered per run.

## Role split

| Role | Who | Does |
|------|-----|------|
| Orchestrator | Current model | Decompose requests, discover repo context, craft prompts, launch/monitor CLI, verify, report |
| Implementer | `grok` | All actual work, default model `grok-4.6` |

## Base command (always use)

```bash
grok -p "PROMPT" \
  --cwd /path/to/repo \
  -m grok-4.6 \
  --always-approve
```

**Mandatory on every run:**
- `-p` / `--single` — headless single-turn mode; prints response and exits. **Never** launch the interactive TUI for delegation.
- `--always-approve` (alias `--yolo`) — auto-approve tool executions; without it a headless run hangs on the first permission prompt.
- `--cwd <PATH>` — absolute path to the repo root (or subproject in a monorepo). Grok walks up to `.git` and loads project instructions/skills from there.
- `-m <MODEL>` — model ID from `grok models` (not a display name with spaces).

**Useful add-ons:**
- `--output-format streaming-json` — newline-delimited events for live monitoring (preferred for long runs).
- `--output-format json` — single JSON object at end; includes `sessionId` for resume.
- `--effort high` — harder reasoning (headless only): `low`, `medium`, `high`, `xhigh`, `max`.
- `--check` — append a self-verification loop before finishing (headless only).
- `--max-turns <N>` — cap agent turns.
- `--sandbox <PROFILE>` — restrict filesystem/network for untrusted code.
- `--disable-web-search` — remove web_search/web_fetch.
- `GROK_LOG_FILE=/tmp/grok-<slug>.log` — pin log path for debugging.
- `--no-auto-update` — skip update checks in CI.

> Grok has **built-in** `--worktree`, `--output-format json|streaming-json`, and `grok sessions list`. Use them instead of hand-rolled substitutes.

## Models — default grok-4.6 (Grok 4.6)

**Default every delegated run to `grok-4.6`.** That is the current Grok 4.6 model (CLI id from `grok models`; also the CLI default). Do **not** use `grok-composer-2.5-fast` unless the user explicitly asks.

| Model | Use for |
|-------|---------|
| `grok-4.6` | **Default for everything** — plan, audit, implement, fix, refactor, hard reasoning |
| `grok-build` | Optional override only for build-heavy / large multi-file / repo-wide refactors when the user wants it |

List models: `grok models`. If a task feels too hard, tighten the prompt, split the task, bump `--effort high`, or run a fix round with `-c` — don't switch models casually.

## Task type → invocation

| Task | Model | Extra flags |
|------|-------|-------------|
| Plan, audit, architecture review (read-only) | `grok-4.6` | `--disallowed-tools "search_replace,write"` + prompt enforces no edits |
| Explain, Q&A, investigate (no edits) | `grok-4.6` | `--tools "read_file,grep,list_dir"` |
| Implement, fix, refactor, test | `grok-4.6` | `--check` optional |
| Hard reasoning / tricky bug | `grok-4.6` | `--effort high` or `xhigh` |
| Large repo-wide refactor | `grok-build` | `--effort high` |
| Untrusted code execution | any | `--sandbox <PROFILE>` |
| Isolated parallel writes | any | `--worktree <name>` per run |
| Best-of-N quality pass | any | `--best-of-n <N>` (headless only) |

There is no read-only CLI mode, so **read-only is enforced by tool restriction + prompt** and verified afterward via `git status`/`git diff`. For audits/plans, the prompt MUST say: *"Do NOT modify, create, or delete any files. Produce only a written plan/audit."*

**Examples:**

```bash
# Plan / audit (read-only enforced in prompt + tools)
grok -p "Read-only: audit the authentication flow. Do NOT edit any files. Output findings + a remediation plan." \
  --cwd /path/to/repo -m grok-4.6 --always-approve --effort high \
  --disallowed-tools "search_replace,write"

# Implement
grok -p "Add input validation to the user-registration handler; follow the repo's existing validation pattern." \
  --cwd /path/to/repo -m grok-4.6 --always-approve --check

# Isolated worktree (safe parallel or experimental edits)
grok -p "Fix the duplicate-event handling in the webhook processor." \
  --cwd /path/to/repo --worktree fix-webhook-dedupe \
  -m grok-4.6 --always-approve
```

## Repo alignment (mandatory in every prompt)

Grok auto-discovers project instructions (`AGENTS.md`, `CLAUDE.md`, rules dirs, skills) from `--cwd`. Still include this block in every delegated prompt so the spawned run prioritizes them:

```
Before doing anything else:
1. Read the repo's agent guidance at the root — AGENTS.md and/or CLAUDE.md, whichever exist. Where both exist, treat them as one combined contract.
2. Follow all repo instructions: stack, build/test commands, workflow, locked decisions, testing policy, and reuse boundaries.
3. Load and follow any rules or domain skills the guidance references for this task.
4. Do not relitigate decisions documented there; surface genuine product forks to the orchestrator instead of choosing silently.
```

The orchestrator must read the repo guidance itself **before crafting the prompt** — that is where the repo's real check commands, conventions, and constraints live — and can run `grok inspect --cwd <repo>` to see exactly what Grok will load.

## Prompt rules

Spawned `grok -p` runs have **no access to this conversation**. Every prompt must be self-contained:

- **Repo alignment block** (above) — always first
- Goal and expected deliverable, with explicit scope boundaries (what NOT to touch)
- Relevant file paths and any domain skills/rules that apply
- Constraints pulled from the repo guidance (security invariants, testing policy, style)
- Verification the agent must run before finishing — **use the repo's own commands** (from its guidance or manifest), not assumed ones
- For audits/plans: explicit **"do not edit files"**

Pass large prompts via `--prompt-file /tmp/grok-<slug>-prompt.md` when the shell would mangle quotes.

## Sessions (fix loop)

```bash
# 1. First delegation (capture sessionId from JSON output)
grok -p "TASK PROMPT" \
  --cwd /path/to/repo -m grok-4.6 --always-approve \
  --output-format json | tee /tmp/grok-task.json

SESSION_ID=$(jq -r '.sessionId' /tmp/grok-task.json)

# 2. Fix round — resume the SAME session
grok -p "Fix: [exact issues from verification]" \
  --cwd /path/to/repo --resume "$SESSION_ID" \
  -m grok-4.6 --always-approve

# Or continue most recent session in this cwd:
grok -c -p "Fix: ..." --cwd /path/to/repo -m grok-4.6 --always-approve
```

- **`-c` / `--continue`** — resume the most recent session for the current `--cwd`. Primary fix-loop when you didn't capture `sessionId`.
- **`--resume <ID>`** — resume a specific session (from JSON `sessionId` or `grok sessions list`).
- **Fresh run** — omit `-c`/`--resume` when prior context would contaminate (wrong approach taken, scope changed).

List sessions: `grok sessions list -n 10`. Cap fix rounds at ~3; then report the blocker to the user with the evidence gathered.

## Live progress monitoring (mandatory)

The orchestrator MUST NOT fire-and-forget a `grok` run. For long tasks, use **streaming-json** into a log and poll:

```bash
SLUG="add-rate-limiter"
LOG="/tmp/grok-${SLUG}.log"

grok -p "PROMPT" \
  --cwd /path/to/repo \
  -m grok-4.6 \
  --always-approve \
  --output-format streaming-json \
  > "$LOG" 2>&1 &
```

While it runs:

1. **Poll** `tail -n 20 "$LOG"` every few seconds; parse `type` (`text`, `thought`, `end`, `error`).
2. **Report** concise live updates (files edited, commands run, blockers).
3. **Intervene early** if off-scope — kill the run and redelegate with a tighter prompt. A run editing the wrong files for 5 minutes is 5 minutes of cleanup.

For quick tasks (< ~30s), foreground is fine — still capture to a log.

**Failure signatures:**

| Symptom | Cause → action |
|---------|----------------|
| Hangs immediately, no output | Missing `--always-approve` → kill, relaunch with it |
| `{"type":"error",...}` in log | Auth/session failure → pre-flight (`grok models`), surface to user if login needed |
| Edits outside the stated scope | Prompt scope too loose → kill, redelegate with explicit "only touch X; do not touch Y" |
| Loops on the same failing step | Context rut → `-c`/`--resume` with a corrective prompt, or `--effort high`, or fresh run |

## Parallel dispatch (multiple grok runs)

When the task splits into **independent domains**, dispatch **one `grok` run per domain in parallel** — built-in worktrees give write isolation:

```bash
REPO=/path/to/repo
BASE=$(git -C "$REPO" rev-parse HEAD)

# Mode A — always --cwd "$REPO" (main repo), never --cwd a worktree path for NEW work
# Cursor/harness: block_until_ms=0, NO trailing &
SWARM_AGENT_NAME="Builder A" grok --prompt-file /tmp/grok-domain-a.md \
  --cwd "$REPO" --worktree wt-domain-a --worktree-ref "$BASE" \
  -m grok-4.6 --always-approve --no-subagents \
  --output-format streaming-json > /tmp/grok-domain-a.log 2>&1

SWARM_AGENT_NAME="Builder B" grok --prompt-file /tmp/grok-domain-b.md \
  --cwd "$REPO" --worktree wt-domain-b --worktree-ref "$BASE" \
  -m grok-4.6 --always-approve --no-subagents \
  --output-format streaming-json > /tmp/grok-domain-b.log 2>&1

# Poll both logs; review diffs; merge worktrees; run full verification.
grok worktree list
```

For swarms, prefer `dispatch-grok.sh` from the `grok-swarm` plugin — see `/grok-swarm` Mode A/B/C/D.

**Use when:** subtasks touch disjoint files/subsystems and each is self-contained after reading the repo guidance.

**Don't use when:** the failures may share one root cause (investigate together first), or the runs would edit the **same files** — worktree isolation prevents corruption but not merge conflicts you'll have to resolve.

Each parallel prompt must state: **scope** (one domain only), **constraints** (don't touch other subsystems), **deliverable** (summary + changes + verification run).

## Structured output

Use `--output-format json` for parseable final results:

```bash
grok -p "...do the work... Then print ONLY a JSON object on the final line: {\"filesChanged\":[],\"summary\":\"\",\"testsRun\":\"\"}" \
  --cwd /path/to/repo -m grok-4.6 --always-approve \
  --output-format json | jq -r '.text'
```

On failure, check for `{"type":"error","message":"..."}` before reading `.text`.

## Isolation: sandbox, tools, worktree

```bash
# Read-only tool allowlist
grok -p "Audit only" --tools "read_file,grep,list_dir" \
  --cwd /path/to/repo -m grok-4.6 --always-approve

# Deny file writes and shell
grok -p "Review" --disallowed-tools "search_replace,write,run_terminal_cmd" \
  --cwd /path/to/repo -m grok-4.6 --always-approve

# Sandbox profile
grok -p "TASK" --sandbox <PROFILE> \
  --cwd /path/to/repo -m grok-4.6 --always-approve

# Isolated git worktree (built-in) — NEW work from main repo only
grok -p "TASK" --worktree feat-name --worktree-ref HEAD \
  --cwd /path/to/repo -m grok-4.6 --always-approve
```

To work in a different repo, point `--cwd` at that repo's root (or subproject path inside a monorepo).

## Worktree cwd footgun (critical for swarms)

Grok's `--cwd` loads project instructions (AGENTS.md, skills) but **does not reliably set the shell cwd** for `run_terminal_cmd`. Observed failure: `--cwd ~/.grok/worktrees/.../wt-X` while the shell still runs in the main repo → edits land in master.

| Intent | Correct pattern |
|--------|-----------------|
| **New parallel work** | `--cwd "$MAIN_REPO" --worktree wt-name --worktree-ref "$BASE"` (Mode A) |
| **Continue existing worktree** | Start the process **inside** the worktree directory (`cd "$WT_PATH"` or Cursor `working_directory`); omit `--worktree` (Mode B) |
| **Resume session in existing worktree** | `--cwd "$WT_PATH" -r "$SESSION_ID"` with the **same `-m`** as the original (Mode C) |
| **Fork session to new worktree** | `grok -w -r "$SESSION_ID"` per [xAI Worktrees docs](https://docs.x.ai/build/features/worktrees) (Mode D) |

**Never:** `-r` without `--cwd "$WT_PATH"` when continuing `wt-*` partial work. **Never:** `--cwd` pointing at `~/.grok/worktrees/...` for new parallel builders.

Full swarm dispatch modes: `/grok-swarm` and `dispatch-grok.sh` from the `grok-swarm` plugin.

## Pre-flight (auth / setup failures)

```bash
grok models                    # lists models → confirms auth
grok inspect --cwd <repo>      # project instructions, skills, permissions grok will load
grok sessions list -n 5        # recent sessions
grok update                    # update CLI if behavior looks stale
```

**Auth for headless:**
- Cached login from `grok login` (automatic)
- CI/headless: `export XAI_API_KEY="xai-..."`
- Remote/no browser: `grok login --device-auth`

If auth fails, surface to the user — they may need to run interactive `grok login` once.

## Orchestrator workflow

```
1. Decompose  → split the request into delegable tasks with explicit scopes
2. Read repo  → agent guidance (AGENTS.md/CLAUDE.md), note its check commands; grok inspect --cwd <repo>
3. Pre-flight → grok models if a run just failed on auth
4. Delegate   → grok -p in background; streaming-json log; monitor live
5. Verify     → read-only: git status/diff, read changed files, run THE REPO'S OWN checks
6. Fix loop   → grok -c or --resume with the exact failure evidence (max ~3 rounds)
7. Report     → what was delegated, live milestones, results, verification output, remaining issues
```

**Verification (orchestrator only, read-only):**
- `git status` / `git diff` — scope check: no unrelated changes, no files outside the stated scope
- Read the changed files — conventions and correctness, not just "it exists"
- Run checks — **the commands the repo itself defines** (in its agent guidance, manifest scripts, Makefile, CI config). Never assume a toolchain; discover it.
- Never edit files yourself

**If verification fails:** do NOT fix it yourself. Delegate the fix via `grok -c`/`--resume` with the exact failing output pasted in.

## Hard rules

- Never edit files directly. All edits go through `grok -p`.
- Always `-p` + `--always-approve`; always `--cwd`; always default `-m grok-4.6` (Grok 4.6). Never default to `grok-composer-2.5-fast`.
- Every prompt includes the repo-alignment block; the orchestrator reads the repo guidance before prompting.
- Read-only work is enforced by tool restriction + prompt, and verified afterward with `git status`.
- **Never fire-and-forget** — stream to a log; monitor live; intervene early.
- **Parallel writes only with `--worktree`** — never two concurrent write-runs on the same working tree.
- Verification uses the repo's own check commands — discovered, not assumed.
- Orchestrator may only: read files, run verification commands, launch/monitor the CLI, talk to the user.
- One focused task per run; chain fix rounds with `-c`/`--resume`; cap at ~3 rounds then escalate to the user.
