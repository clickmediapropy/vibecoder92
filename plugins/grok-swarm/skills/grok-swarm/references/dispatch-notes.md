# Dispatch notes unique to SKILL.md (not already in `reference.md`)

Role flag **tables** and env vars live in [`reference.md` § Role dispatch flags](../reference.md). Dispatch modes A–D, pause/resume, gate semaphore, leader-mode verdict: same file.

Effort defaults (via `dispatch-grok.sh --agent`): Scout → `low`; Builder → `medium`; Reviewer/Visual/Logger/Coordinator → `high`. Override: `--effort` or `GROK_SWARM_EFFORT`. `run-coordinator.sh` stays `high`.

Builder prompts from `templates/builder-prompt.md` (self-contained; `dispatch-grok.sh` auto-strips HTML comments). `$BASE` = `git rev-parse HEAD`, same ref for all parallel builders.

Post-dispatch sanity ≤30s: worktree exists + `dispatch record --verify-worktree`, log growing, `git -C "$WT_PATH" rev-parse --show-toplevel != main`. On fail: mark `failed`, audit `git -C "$REPO" status`, redispatch Mode B fresh. On `MODEL_SWITCH_INCOMPATIBLE_AGENT` → Mode B fresh, no `-r`.

Harness: Cursor reaps `cmd &`/`nohup` — one `Shell` per builder `block_until_ms: 0` no `&`, `working_directory=$WT_PATH` for Mode B, dashboard always `--daemon`, parallel builders via multiple `Shell` calls in one turn (see `reference.md` § Cursor harness).

Dashboard UI extras: Topbar **Hold / Pause / Resume** buttons + **Coordinator chat** panel (free text → coordinator inbox; replies from `transcript/`) + **Add task** form (`swarm task create`). Routes: `reference.md` §Dashboard control routes.

Identity: always `export SWARM_AGENT_NAME=Coordinator` before `swarm`/`grok` (don’t rely on inline `VAR=... cmd` for persistent sessions).
