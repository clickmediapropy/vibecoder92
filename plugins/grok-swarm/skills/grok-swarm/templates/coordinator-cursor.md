# Grok-swarm parent (Cursor / Claude / Codex / Grok)

**Default = autonomous.** You plan tasks, launch the Grok coordinator, then **EXIT**.

**Effort:** Scout=`low`, Builder=`medium`, Reviewer/Visual/Logger/Coordinator=`high` (auto via `dispatch-grok.sh --agent`).

**Models:** `bin/model-pin.env`. Override workers with `GROK_SWARM_WORKER_MODEL` / `dispatch-grok.sh --model`.

**CLI:** Mode A is `dispatch-grok.sh --mode new` (pre-create the git worktree, process cwd = that tree). See `reference.md` header for the live `--worktree` probe. Resume `-r` accepts session ID or title.

Do **not** use `Write` / `StrReplace` / host `Task` subagents for implementation.

## Autonomous path (default)

```bash
export SWARM_AGENT_NAME=Coordinator
REPO=/path/to/any/git/repo
# discover gates from REPO, then:
swarm init "$REPO" --fresh --goal "…" --agents "Coordinator:coordinator,Builder 1:builder,…"
swarm task create --title "…" --owner "Builder 1" \
  --files "<real paths in this repo>" --acceptance "<this repo's gates>"
swarm check            # must pass WITHOUT --allow-serial-hub
swarm launch "$REPO"    # dashboard + coordinator daemons
# STOP. User watches the dashboard. Do not poll logs or merge.
```

### Hot-hub / shared surface (mandatory)

If features share a multi-file hub (tool registry, schemas, executors, dual routes, locales, approval UI):

1. **Do not** create Phase2→PhaseN tasks that each lease the full hub under `--depends` (legal but serial — fake swarm).
2. Create **domain pack** tasks on **NEW disjoint files** (parallel) + **one wire** task that alone owns the hub.
3. `swarm check` fails on `serial_hub_chain` (≥3 tasks sharing ≥3 hub files via depends). Replan; do not launch.
4. Pattern doc: `docs/2026-08-07-hot-hub-adjudication.md` (in this skill).

Resume: `swarm resume` (if paused) then `swarm coordinator start --resume --daemon`.

## Manual Mode B only (debug)

Only if the user asks you to drive the loop or `swarm coordinator status` is dead:

```bash
${CLAUDE_PLUGIN_ROOT}/skills/grok-swarm/bin/coordinator-guard.sh --repo "$REPO" --expect-clean
${CLAUDE_PLUGIN_ROOT}/skills/grok-swarm/bin/dispatch-grok.sh --mode new \
  --repo "$REPO" --worktree wt-<slug> --base "$(git -C "$REPO" rev-parse HEAD)" \
  # Mode A: wrapper pre-creates git worktree + cwd isolation — never raw grok --worktree
  --agent "Builder 1" --prompt-file /tmp/grok-swarm-<slug>.md \
  --log /tmp/grok-swarm-<slug>.log
```

Full rules: `${CLAUDE_PLUGIN_ROOT}/skills/grok-swarm/SKILL.md`.

**Double-check:** every builder must run `/double-check` (`{{SKILL_ROOT}}/../double-check/SKILL.md`) and leave `.grok-swarm/double-check/<taskId>.md` with result **complete** before merge. Coordinators enforce this; parents in Mode B must too.
