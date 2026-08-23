---
name: usegrok
description: Use when the user says usegrok, "delegate to grok", "ask grok", or wants a single headless Grok CLI (`grok -p`) task from Claude, Codex, Cursor, or Muse. Not for multi-task parallel builds (use grok-swarm) and not when already inside an interactive Grok session.
---

# usegrok

Single-task headless `grok -p` from another parent. You are the **orchestrator**: craft the prompt, launch, monitor, verify. Grok does the work.

Verified against **grok 1.0.5**. `grok --help` wins if this file lags. Flag dump: [GROK-CLI-REFERENCE.md](GROK-CLI-REFERENCE.md).

## When

| Use | Don't |
|-----|--------|
| One focused plan / audit / fix / implement | 2+ independent domains → **grok-swarm** |
| Cross-parent hand (Claude/Codex/Cursor/Muse → Grok) | Already in an interactive Grok session → do the work yourself |
| User says usegrok / "delegate to grok" / "ask grok" | Parallel `grok -p` writers on the same checkout |

## Invoke

```bash
grok --prompt-file /tmp/grok-<slug>.md \
  --cwd /absolute/path/to/repo \
  -m grok-4.6 \
  --always-approve \
  --output-format streaming-json
```

Exactly one prompt source: `--prompt-file` (preferred) **or** `-p` **or** `--prompt-json`. Never combine them (`'--single <PROMPT>' cannot be used with '--prompt-file'`).

Every run needs `--always-approve` (headless hangs on the first permission prompt without it), `--cwd` (absolute), and `-m grok-4.6` (`grok models`; do not invent ids).

| Task | Extra flags |
|------|-------------|
| Plan / audit (no edits) | `--permission-mode plan --disallowed-tools "search_replace,write"` + prompt: do not edit files. Then `git status` must be clean. If plan mode exits after one line, rerun without `--permission-mode plan` and keep the denylist + prompt. |
| Investigate (no edits) | `--tools "read_file,grep,list_dir"` |
| Implement / fix / test | (base flags). Hard bug: `--effort high` or `xhigh`. |
| Untrusted code | `--sandbox workspace` or `strict` |
| Parseable result | `--output-format json` (implies wait-until-end). `--json-schema '{...}'` constrains the model's JSON and implies `json`. |

**Dead flags (1.0.5 rejects):** `--check`, `--best-of-n`. Do not pass them.

**Worktree:** `grok -p --worktree` does **not** create a worktree. Isolation for one experimental run: `dispatch-grok.sh (grok-swarm plugin) --mode new …`. Multi-task: grok-swarm, not this skill.

## Workflow

1. **Decompose** — one focused task, explicit files in / files out.
2. **Read repo** — `AGENTS.md` / `CLAUDE.md`; `grok inspect --cwd <repo>` if you need what Grok will load. Note the repo's own check commands.
3. **Prompt** — write `/tmp/grok-<slug>.md` (self-contained; this conversation is invisible to Grok).
4. **Pre-flight** — only if the last run failed on auth: `grok models`. Login: cached `grok login`, or `XAI_API_KEY`, or `grok login --device-auth`.
5. **Delegate** — harness **background** (Grok: `background: true`; Cursor: `block_until_ms: 0`, no trailing `&`). Stream to a log. Poll. Kill and redelegate if it edits the wrong files.
6. **Verify (orchestrator, read-only)** — `git status` / `git diff` (scope), read changed files, run **the repo's** checks. Never assume a toolchain. Never edit files yourself.
7. **Fix** — `grok --prompt-file <fix.md> --cwd <repo> -c` (or `-r <sessionId>`) with the exact failing output. Same `-m`. Cap ~3 rounds, then report the blocker.

Quick tasks (< ~30s) may run in the foreground. Still capture a log.

## Prompt

Spawned Grok has **no** parent-conversation context. Every prompt includes, in order:

1. Repo alignment block (below)
2. Goal + deliverable + files in / files out
3. Paths, skills, and constraints taken from the repo guidance
4. Verification commands **from that repo**
5. Audits: "Do NOT modify, create, or delete any files."

```
Before doing anything else:
1. Read the repo's agent guidance at the root — AGENTS.md and/or CLAUDE.md, whichever exist. Where both exist, treat them as one combined contract.
2. Follow all repo instructions: stack, build/test commands, workflow, locked decisions, testing policy, and reuse boundaries.
3. Load and follow any rules or domain skills the guidance references for this task.
4. Do not relitigate decisions documented there; surface genuine product forks to the orchestrator instead of choosing silently.
```

## Sessions

First run with `--output-format json` (or parse `sessionId` from a streaming `end` event) if you expect a fix loop.

```bash
# Continue most recent session for this --cwd
grok --prompt-file /tmp/grok-fix.md --cwd /path/to/repo -c \
  -m grok-4.6 --always-approve

# Resume a captured id (UUID-shaped values are always ids; titles match current dir)
grok --prompt-file /tmp/grok-fix.md --cwd /path/to/repo -r "$SESSION_ID" \
  -m grok-4.6 --always-approve
```

Keep the same `-m` on resume. Wrong model → `MODEL_SWITCH_INCOMPATIBLE_AGENT`: fresh run, no `-r`. Scope changed or the first approach is wrong → omit `-c`/`-r`. Optional: `--fork-session` with `-r`/`-c` to keep the original session clean.

`grok sessions list -n 10`

## Monitor

Never fire-and-forget. For long runs:

```bash
LOG=/tmp/grok-<slug>.log
grok --prompt-file /tmp/grok-<slug>.md \
  --cwd /path/to/repo -m grok-4.6 --always-approve \
  --output-format streaming-json > "$LOG" 2>&1
```

Poll `tail -n 20 "$LOG"`. Switch on `type`: `text`, `thought`, `tool_call`, `end`, `error`. Report files edited and commands run. Intervene early on scope drift.

`--output-format json` is the final object (`text`, `sessionId`, `stopReason`). Check `{"type":"error","message":"..."}` before reading `.text`. Exit `0` = success, `1` = error, `130`/`143` = interrupted (resume with `-r`/`-c`; file edits are not rolled back).

## Failures

| Symptom | Action |
|---------|--------|
| Hangs immediately, no output | Missing `--always-approve` → kill, relaunch with it |
| `unexpected argument '--check'` / `'--best-of-n'` | Dead flags → drop them |
| `'--single <PROMPT>' cannot be used with '--prompt-file'` | One prompt source only |
| `{"type":"error",...}` / auth | `grok models`; if login needed, surface it |
| Edits outside scope | Kill; tighter files-in / files-out |
| Loops the same failing step | `-c`/`-r` with the exact error, or `--effort high`, or fresh run |
| `MODEL_SWITCH_INCOMPATIBLE_AGENT` | Fresh run, same or corrected `-m`, no `-r` |

## Hard rules

- Never edit the target repo yourself. Fixes go through `grok -p` / `-c` / `-r`.
- Always `--always-approve`, `--cwd`, `-m grok-4.6`.
- Never `--check` or `--best-of-n`. Never `-p` plus `--prompt-file`.
- Never `grok -p --worktree` for isolation. Never two concurrent write-runs on the same working tree.
- Never fire-and-forget. Verify with the repo's own checks.

## Red flags — still follow the skill

- "I'll just save this one-liner" / a senior says skip the delegate
- `--check` or `grok -p --worktree` because training data or a 20-minute demo
- Nested `grok -p` from an interactive Grok session
- One prompt covering two domains "to save time"

| Excuse | Reality |
|--------|---------|
| One-liner already in the buffer, prod is down | Nico said usegrok. Discard the buffer. Delegate. |
| Swarm is too slow for a demo | Two domains → grok-swarm. Dead flags fail or clobber main. |
| usegrok while already in Grok TUI | Do the work in this session. |

---

Made by [nicodelgado.dev](https://nicodelgado.dev).
