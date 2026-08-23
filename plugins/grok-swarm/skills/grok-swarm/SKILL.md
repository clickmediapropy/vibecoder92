---
name: grok-swarm
description: "Use when running a multi-agent coding swarm with Grok CLI builders on any git repo (parallel worktrees, /grok-swarm, /grok-swarm launch, autonomous coordinator, or when the parent must not babysit dispatch/monitor/merge). Repo-agnostic; overrides host Task/specialist delegation while active."
---

# grok-swarm — Run a multi-agent coding swarm on Grok CLI

**Plugin layout:** this skill ships inside the `grok-swarm` Claude Code plugin. `swarm` = `${CLAUDE_PLUGIN_ROOT}/skills/grok-swarm/bin/swarm`; sibling skills at `${CLAUDE_PLUGIN_ROOT}/skills/usegrok/` and `${CLAUDE_PLUGIN_ROOT}/skills/double-check/`. Prefix `export PATH="${CLAUDE_PLUGIN_ROOT}/skills/grok-swarm/bin:$PATH"` before any `swarm ...` command below.


**Repo-agnostic** parallel builds via **Grok CLI workers** (`grok -p` + isolated worktrees), shared board, file mail, event-sourced tasks, dispatch tracking, verify+fix loop, and merge. No assumed language/framework — stack and gates come from the target checkout. Zero third-party deps — only `grok` and Node.

**Default is autonomous:** parent **plans** (init + tasks), runs `swarm launch`, then **exits**. A detached **Grok CLI coordinator** owns dispatch/monitor/verify/merge. Manual parent-as-coordinator is debug fallback only.

Read **`/usegrok`** (`${CLAUDE_PLUGIN_ROOT}/skills/usegrok/SKILL.md`) for the canonical `grok -p` contract. Flag reference: **`${CLAUDE_PLUGIN_ROOT}/skills/usegrok/GROK-CLI-REFERENCE.md`**.

> **Multi-task swarms use grok-swarm, not parallel `/usegrok` sessions.** Single change → `/usegrok` alone.

> Verified against **Grok CLI v1.0.3** (`grok --version`; skill last audited **2026-08-12**). Workers use Mode A via `dispatch-grok.sh` (pre-create git worktree + cwd; **no** `grok --worktree` on launch). Model: **`grok-4.6`** (CLI default; `grok-4.5` still listed). Coordinator + heal + dead-PID auto-reconcile unchanged. Latest stable is **1.0.3** (`grok update --check --json` shows `updateAvailable: false`).

Full flag tables, CLI details, and mega/heal deep dives live in [`reference.md`](reference.md) — this file is the lean operator entrypoint.

## Role dispatch flags — summary (source: reference.md §Role dispatch flags)

`dispatch-grok.sh` applies role-aware argv from `--agent` (case-insensitive substring). **No worker passes `--check` or `--best-of-n`** (both still rejected on 1.0.3; verified `grok -p "test" --check` → `unexpected argument`).

| Role (agent label) | max-turns | no-subagents | disallowed-tools | sandbox when `GROK_SWARM_SANDBOX≠off` | disable-web | json-schema |
| --- | --- | --- | --- | --- | --- | --- |
| `*scout*` / `*review*` / `*logger*` | yes (100) | yes | `search_replace` | `read-only` | no | no |
| `*visual*` | yes (100) | yes | `search_replace` | `workspace` | no | no |
| `*builder*` / `*worker*` / `*fix*` / default | yes (100) | yes | (none) | `workspace` | if `DISABLE_WEB=1` | if `replace` |
| Coordinator (`run-coordinator.sh`) | 500 | **no** | none | none | no | no |

Effort defaults (via `dispatch-grok.sh --agent`): Scout → `low`; Builder → `medium`; Reviewer/Visual/Logger/Coordinator → `high`. Override: `--effort` or `GROK_SWARM_EFFORT`. `run-coordinator.sh` stays `high`.

Optional env vars:

| Variable | Default | Meaning |
| --- | --- | --- |
| `GROK_SWARM_WORKER_MAX_TURNS` | `100` | `--max-turns` for non-coordinator workers |
| `GROK_SWARM_WORKER_JSON_SCHEMA_MODE` | `off` | `off` \| `replace` → `--output-format json --json-schema worker-done.schema.json` (no streaming). See §Double-check for validation |
| `GROK_SWARM_WORKER_JSON_SCHEMA` | `0` | Compat: `1` → `replace` |
| `GROK_SWARM_SANDBOX` | `off` | `workspace` enables sandbox row above |
| `GROK_SWARM_DISABLE_WEB_SEARCH` | `0` | `1` → `--disable-web-search` on **builders only** (scouts/reviewers keep web for discovery/audit) |
| `GROK_SWARM_FORK_ON_FIX` | `1` | Fix-loop resume adds `--fork-session` with `-r` |
| `GROK_SWARM_WORKTREE_GC` | `1` | `0` skips `grok worktree gc` on mega cleanup (soft-fails with warning when `1`; set `0` to silence) |
| `GROK_SWARM_WORKTREE_GC_MAX_AGE` | `7d` | Passed as `grok worktree gc --max-age`. Without `--max-age` the CLI expires nothing |

**CLI 1.0.3 contract (adopted):** headless `-p` **does not create a worktree** from `--worktree` — Mode A stays `dispatch-grok.sh` (git worktree + process cwd). `-r` matches session **ID or title** (UUID-shaped values always mean IDs; prefer recorded sessionId). Pre-flight adds `grok doctor --json` and `grok du --json`. Cleanup uses `grok worktree gc --max-age 7d`. TUI-only: `--fullscreen` / `--minimal`. Full delta: reference.md §New in 1.0.3.

## Autonomous mode (default) — parent launch-and-exit

| Slash / action | Parent does | Then |
|----------------|-------------|------|
| `/grok-swarm launch <goal>` | Read repo, `swarm init --fresh`, create disjoint tasks, `swarm check`, **`swarm launch`** | **EXIT** — don’t monitor |
| `/grok-swarm resume` | If paused: `swarm resume`, then `swarm coordinator start --resume --daemon` (+ dashboard if dead). Same as the dashboard **Resume** button | **EXIT** |
| `/grok-swarm pause` | `swarm pause` + `swarm coordinator stop`. Same as the dashboard **Pause** button; **Hold** = `swarm pause --no-kill` (builders finish, no new dispatch) | Stop |

```bash
export SWARM_AGENT_NAME=Coordinator
REPO=/path/to/repo
swarm init "$REPO" --fresh --goal "One-sentence goal" \
  --agents "Coordinator:coordinator,Builder 1:builder,Builder 2:builder,Reviewer:reviewer"
# create tasks (disjoint --files), then:
swarm check
swarm launch "$REPO"          # dashboard --daemon --open + coordinator --daemon + heal daemon
# Parent STOP. User watches http://127.0.0.1:4599/ (also auto-exposed via tailscale serve — `swarm dashboard status` prints the https://<host>.ts.net:4599/ URL)
```

**Anti-pattern:** after `swarm launch` / `coordinator start --daemon` don’t poll logs, merge, or redispatch unless `swarm coordinator status` shows dead.

| Command | Purpose |
|---------|---------|
| `swarm coordinator start [--resume] [--daemon]` | Detached Grok coordinator (`templates/coordinator-prompt.md` → `.grok-swarm/coordinator-prompt.md`; pidfile `coordinator.pid`) |
| `swarm coordinator status` / `stop` | Liveness / SIGTERM |
| `swarm launch [<repo>]` | Dashboard + coordinator + heal daemon (optional init via `--goal`/`--fresh`/`--agents`; `--no-healer` to skip) |
| `swarm heal` / `heal --daemon` | Self-monitor — reconcile dead dispatches, restart dead dashboard/coordinators, promote visual PASS |

Manual parent-as-coordinator: debug only — see reference.md §Role split Mode B.

## Grok CLI headless — essentials

Full tables: `reference.md` §Grok CLI headless commands. Highlights:

- **Prompt source:** exactly one of `-p` / `--prompt-file` (preferred) / `--prompt-json`. Never combine `-p` + `--prompt-file`.
- **Mandatory on every `grok` run:** `--always-approve`, `--cwd`, `-m grok-4.6`; workers add `--no-memory` (isolation). Resume with same `-m`; on `MODEL_SWITCH_INCOMPATIBLE_AGENT` redispatch Mode B.
- **Output:** `plain` / `json` (+ `--json-schema worker-done.schema.json`) / `streaming-json` (preferred) / `streaming-messages-json` (needs `--include-partial-messages`).
- **Sessions:** `-c` / `-r <ID-or-title>` / `-s <UUID>` / `--fork-session` / `--restore-code` (remote D only). Mode C: always `--cwd "$WT_PATH"` + `-r`/`-c` with same `-m`; never `-c/-r/-s` + `--worktree` on existing `wt-*` (silently edits MAIN). Mode D `grok -w -r <ID>` only for intentional fork to fresh worktree.
- **Worktrees:** 1.0.3: `grok -p --worktree` does **not** create a tree. Always `dispatch-grok.sh --mode new` (pre-create `git worktree` + cwd). Manage leftovers with `grok worktree list|rm` and `grok worktree gc --max-age 7d`.
- **Read-only review:** `--permission-mode plan` + `--disallowed-tools "search_replace,write"` (+ `--tools "read_file,grep,list_dir"` tightening); verify `git status` unchanged.
- **Pre-flight:** `grok --version && grok models && (cd "$REPO" && grok inspect --json) && grok update --check --json && grok doctor --json && grok du --json`

## Role split

| Role | Who | Does |
|------|-----|------|
| **Parent (planner)** | Cursor/Claude/Codex/interactive Grok | Decompose goal, `swarm init` + tasks, `swarm launch` or `coordinator start`, then **exit** |
| **Coordinator** | Detached `grok` via `swarm coordinator start` (or manual Mode B) | Dispatch/monitor/verify/merge. **Never edits app code.** `grok-4.6` |
| **Builder** | `grok -p` inside isolated worktree | Implements one disjoint file set. `grok-4.6` |
| **Reviewer** | `grok -p --permission-mode plan` | Read-only audit; coordinator verifies `git status` unchanged. `grok-4.6` |

| Mode | When | Who runs the loop |
|------|------|-------------------|
| **A — Autonomous (default)** | `/grok-swarm launch` | Grok CLI coordinator daemon |
| **B — Manual (fallback)** | Debug / coordinator dead | Parent follows reference.md orchestrator loop |

Coordinator is orchestrator only — never implementer.

## Parent contract (mandatory)

**Activation:** `/grok-swarm` attached → until swarm completes or user cancels (`stop swarm`, `commit yourself`).

**Autonomous default:** plan + launch + exit. Enter monitor loop only in Mode B or when `swarm coordinator status` dead and user wants parent takeover.

**Design:** grok-swarm **supersedes** target repo’s “delegate to specialist / Task” rules for implementation while active. Works on **any** git repo.

Forbidden: `Write`/`StrReplace`/`Delete` on target repo (except `.grok-swarm/` notes), `Task`/specialist subagents for implementation, `CreatePlan` mid-flight, hand-editing merge hunks. Allowed: `Read`/`Grep`/`Glob`, `Shell` for `coordinator-guard.sh`/`dispatch-grok.sh`/`swarm`/`grok worktree`/`git status/log/merge` + verify gates on worktrees/post-merge, `AskQuestion`, `git merge` verified worktree branches.

Instruction precedence: grok-swarm overrides “delegate to specialist” and “implement fast” and “parent babysitting” — not “stop swarm” / explicit cancel. See `templates/coordinator-cursor.md` + `templates/coordinator-prompt.md`.

## When to use

**Use when:** goal splits into 2+ independent subsystems with disjoint files, reproducible coordinator/builders/reviewer team needed, or user asks “grok swarm”.

**Don’t use when:** single small change (`/usegrok` once), subtasks share files (sequence in one builder or `--depends`), or failures share one root cause (focused single run).

**Sizing (single swarm):** 2–4 builders per sub-swarm; beyond ~5 overhead wins.

**Sizing (mega):** host ceilings from [`templates/host-capacity.default.json`](templates/host-capacity.default.json) / `bin/capacity.cjs` — **16** coordinators / **30** builders / **15** reviewers / **10** scouts / **6** loggers / **8** visual / **10** dev servers. These are host-owned ceilings via `swarm capacity set` / `.grok-swarm/host-capacity.json` (see `swarm capacity show`), not a hard “4 coordinators” law. See `docs/2026-07-14-mega-swarm-design.md`. Parallel megas share free slots; `mega check`/`launch` refuse lease clashes unless `--force`.

Micro-pack default (`swarm mega propose`): ~20 packs, 1 builder per single-dir pack, scout only on `visual_tier: full`, host ceilings as above. Quality bar: gates + double-check + visual findings (`docs/2026-07-15-fast-quality-bar.md`). Visual tiers `full`/`smoke`/`gates_only`; auth BLOCKED → `swarm mega visual pass` / `swarm heal --auto-visual-pass` (never force product REVISE).

Host hygiene: cleanup kills worktree Vite; `swarm capacity show` warns if `> max_dev_servers`; prefer one FE mega per host. 1.0.0 sandbox fix: `GROK_SWARM_SANDBOX=workspace` no longer hangs on large deny-glob trees.

Worktree env seed: `dispatch-grok.sh --mode new` copies `worktree-seed.json` paths (`.env.local`/secrets) MAIN → worktree; seeded files are gitignored and removed when the worktree is cleaned (`grok worktree rm` + `host-capacity`/mega cleanup). Never commit them.

Cleanup (mandatory, automated): `swarm goal update --status completed` auto-runs `swarm cleanup --swarm <id>` (worktrees + `swarm/wt-*` branches + archive; seeded env deleted with worktree). Soft-fails `grok worktree gc --max-age 7d` warns when `GROK_SWARM_WORKTREE_GC=1` (set `0` to skip). Heal fallback cleans stale `wt-*` if goal already completed; mega meta runs `swarm mega cleanup --full`; logger after **every** merge → `docs/solutions/` or `.grok-swarm/learnings/`. Disk: `grok du --json` lists `~/.grok` (sessions + worktrees) before a sweep.

## Coordination tooling — `bin/swarm`

Zero-dependency `bin/swarm` → `bin/swarm.cjs` inside target repo `.grok-swarm/` (board, `inbox/`, `plan/events/`, `dispatches/`). Identity via `SWARM_AGENT_NAME`. `swarm help [topic]` for full usage; `swarm --version` prints skill + capacity defaults. Auto-cleanup after `goal completed` now deletes both `~/.grok/worktrees` *and* `swarm/wt-*` branches (heal fallback counts branches too); dashboard/heal daemons are stopped via `swarm coordinator stop && swarm dashboard stop && swarm heal stop` or `swarm pause --all` (which scavenges and checks residual).

| Command | Purpose |
|---------|---------|
| `swarm init <repo> --goal "..." --agents "..." [--fresh]` | Create workspace. Always `--fresh` for NEW swarm — archives stale state |
| `swarm task create --title --owner --files --acceptance [--depends] [--force]` | Add task; refuses file overlaps unless `depends`/`force`; `--depends` must not chain 3+ identical hub tasks (`serial_hub_chain`) |
| `swarm task ready [--json]` | Dispatchable tasks (open/assigned with deps done) |
| `swarm task update --id --status ...` | Move through `open→assigned→building→review→done` / `blocked` |
| `swarm check [--json]` | Validate: overlaps, missing deps, cycles, `serial_hub_chain`. Must pass before dispatch |
| `swarm dispatch record/update/list/reconcile` | Track `grok` runs (worktree/log/PID/session/base). `reconcile` + dashboard/watch auto-heal dead-PID `running` → `done`/`failed` |
| `swarm mail send/check/peek` | File mail (`peek` non-consuming, exit code poll) |
| `swarm agent register/list` | Add agents post-init (keeps `@all` working) |
| `swarm board [--sync]` | Board; `--sync` rewrites `SWARM_BOARD.md` markers |
| `swarm dashboard --daemon [--port 4599] [--open]` / `stop` / `status` | Mission-control UI (localhost, 2–5s poll, RAM display, auto `pause --all` < `min_free_ram_gb`). Topbar **Hold / Pause / Resume** buttons + **Coordinator chat** panel (free text → coordinator inbox; replies from `transcript/`) + **Add task** form (`swarm task create`). Routes: reference.md §Dashboard control routes |
| `swarm watch [<mega-id>] [--once] [--json] [--loop]` | Live board (SSH-friendly) / mega+coordinator status |
| `swarm swarms list|use|archive` / `migrate` / `conflicts` | Registry, migration, overlap warnings |
| `swarm pause [--all] [--reason "..."] [--no-kill] [--no-scavenge]` | Tree-kill builders (SIGTERM→SIGKILL), stop daemons, scavenge orphans, residual check (exit 2 if alive) |
| `swarm resume [--all]` | Lift pause, print Mode C/B relaunch cmds (`-m grok-4.6` + `--cwd`) |
| `swarm coordinator start\|status\|stop` | Autonomous Grok daemon (pidfile `coordinator.pid`, log `coordinator.log`) |
| `swarm launch [<repo>]` | Dashboard + coordinator + heal daemon ( `--no-healer` to skip) |
| `swarm heal [doctor\|status\|stop]` / `heal --daemon` | Mechanical self-monitor (see reference.md §heal) |
| `node bin/gate.cjs [--max N] -- <cmd>` | Heavy-tool semaphore: caps concurrent `tsc`/`vitest`/`npm install`/builds at `max_heavy_tools` (default 3); slots `.grok-swarm/gate-slots/`, stale-PID reclaim (see §Heavy-tool governor) |
| `bin/leader-spike.sh <repo> [n]` | One-shot S0–S4 leader-mode measurement (see reference.md §Leader mode verdict) |
| `swarm --version` | Skill audit date + host capacity defaults + `grok --version` probe |

Identity required on every call — always `export SWARM_AGENT_NAME=Coordinator` before `swarm`/`grok` (don’t rely on inline `VAR=... cmd` for persistent sessions). Templates: `builder-prompt.md`, `coordinator-prompt.md`, `worker-done.schema.json`, etc.

## Parent phase checklist (autonomous)

- [ ] Pre-flight: `grok --version` (≥1.0.3), `grok models` (default `grok-4.6`), `swarm init --fresh`, agents registered
- [ ] Plan: `swarm task create` disjoint; `swarm check` passes
- [ ] Launch: `swarm launch "$REPO"` (or dashboard + `coordinator start --daemon`)
- [ ] Verify: `swarm dashboard status` + `swarm coordinator status`
- [ ] EXIT — watch browser; don’t babysit

Manual Mode B checklist: see reference.md.

## Orchestrator loop — compressed (full steps in reference.md)

1. **Decompose** into disjoint-file tasks (discover repo via `AGENTS.md`/`grok inspect`; owned `--files` must be real paths).
2. **Init + plan:** `export SWARM_AGENT_NAME=Coordinator; swarm init --fresh --goal ... --agents ...` → `task create` per domain → `swarm check` + `coordinator-guard.sh --expect-clean` → `swarm board --sync`.
3. **Dashboard (mandatory, right after plan):**
```bash
export SWARM_AGENT_NAME=Coordinator
swarm dashboard --daemon --open --cwd "$REPO"
# detached; pidfile .grok-swarm/dashboard.pid, log .grok-swarm/dashboard.log
# SSH fallback: swarm watch
```
`--open` required, `--daemon` mandatory in harnesses. Verify `swarm dashboard status` before dispatch; port busy → `--port <n>` + re-`--open`. Keep current: `swarm task update` + `dispatch record/update` + `board --sync` after every wave — stale board = coordination failure.

4. **Dispatch ready tasks — modes A/B/C/D** via `dispatch-grok.sh` (see `dispatch-grok.sh --help`). Mode A: `dispatch-grok.sh --mode new --repo REPO --worktree wt-X --base BASE --agent "Builder 1" --prompt-file /tmp/... --log /tmp/...` (pre-creates `git worktree`, cwd = worktree; never raw `grok --cwd REPO --worktree`). Mode B: `dispatch-grok.sh --mode existing --worktree-path $WT_PATH` (cwd = worktree). Mode C fix loop: `--cwd "$WT_PATH" -r $SESSION -m grok-4.6`; never `-r` without `--cwd`. Mode D `grok -w -r` only for intentional fork. Builder prompts from `templates/builder-prompt.md` (self-contained; `dispatch-grok.sh` auto-strips HTML comments). `$BASE` = `git rev-parse HEAD`, same ref for all parallel builders.

Post-dispatch sanity ≤30s: worktree exists + `dispatch record --verify-worktree`, log growing, `git -C "$WT_PATH" rev-parse --show-toplevel != main`. On fail: mark `failed`, audit `git -C "$REPO" status`, redispatch Mode B fresh. On `MODEL_SWITCH_INCOMPATIBLE_AGENT` → Mode B fresh, no `-r`.

5. **Harness:** Cursor reaps `cmd &`/`nohup` — one `Shell` per builder `block_until_ms: 0` no `&`, `working_directory=$WT_PATH` for Mode B, dashboard always `--daemon`, parallel builders via multiple `Shell` calls in one turn (see reference.md §Cursor harness).

6. **Monitor** every 15–30s: `swarm dispatch list --status running`, `tail` log, `swarm mail check --consume`, `git -C <wt> status --short` (kill on scope drift + redelegate).

7. **Verify read-only** on `worker_done`/`end`: `git -C <wt> status/diff` scoped gates; mark `dispatch update --status done` + `task update --status review`.

8. **Fix loop (≤3 rounds)** — Mode C `grok --prompt-file <fix.md> --cwd $WT_PATH -r $SESSION -m grok-4.6 --fork-session` (or `-c` if no session). Never `-r` without `--cwd`; on model mismatch → Mode B fresh. After 3 fails: `task update --status blocked`.

9. **Reviewer pass** (optional, read-only): `grok --prompt-file ... --cwd $REPO -m grok-4.6 --permission-mode plan --output-format streaming-json` → `git -C "$REPO" status` unchanged. Headless plan mode may exit after intro line → rerun without plan mode using precomputed diff + strict prompt.

10. **Merge verified worktrees:**
```bash
git -C "$REPO" merge --no-ff <wt-branch-a> -m "swarm: merge domain A (task-xxxx)"
git -C "$REPO" merge --no-ff <wt-branch-b> -m "swarm: merge domain B (task-yyyy)"
```
On conflict: don’t hand-resolve — delegate builder. Mega integrate: `swarm mega run --auto-merge` skips already-integrated branches, union-resolves only `INDEX`/`learnings`/`SUMMARY` via `merge-file --union`, else `merge_blocked` + builder prompt under `.grok-swarm/mega/<id>/`. After merges: full repo gates, then `grok worktree rm` + `task update --status done` + `goal update --status completed` + `board --sync`. Seeded `.env` files disappear with worktrees.

## Pausing & resuming

`swarm pause --all` tree-kills builders, writes `pause.json` (per run: dispatch/task/agent/worktree/session/log/base/kill outcome), stops daemons. `swarm resume` archives manifest, prints per-builder relaunch cmds (Mode C with `-r` + `--cwd` + `-m grok-4.6`; Mode B with `-c` + cwd). While paused `dispatch record` refuses (`--force` override). `pause/resume --all` handles all sub-swarms.

## Heavy-tool governor (RAM)

The RAM killer under parallel load is not the grok processes — it is concurrent gate subprocesses (`tsc`, `vitest`, `npm install`, builds; ~1 GB RSS each). `bin/gate.cjs` is a slot semaphore that caps them host-wide:

```bash
node <skill>/bin/gate.cjs -- npm run typecheck    # blocks until a slot frees; releases on exit
```

Ceiling: `max_heavy_tools` in host capacity (default **3**; `swarm capacity set --max-heavy-tools N`). Slots live in `<nearest .grok-swarm walking up from cwd>/gate-slots/` — for worktree builders that is usually NOT the target repo's workspace but whatever `.grok-swarm/` exists above `~/.grok/worktrees/` (e.g. a stray `~/.grok-swarm/` from a past home-dir run); only when none exists on the whole ancestor path does it fall back to `/tmp/grok-gate-slots`. Same resolution picks the capacity file, so a repo's `max_heavy_tools` override does not reach worktree builders — they use the default 3 unless you pass `--max`/`--slots-dir` explicitly. Stale and poisoned slot files are reclaimed. Advisory like file leases — `templates/builder-prompt.md` instructs builders to route every heavy gate through it; the coordinator should run post-merge gates through it too.

**Leader mode: rejected 2026-08-13.** `grok agent leader` + `--leader` clients multiplex sessions correctly, but grok 1.0.3 clients are full-weight processes — 8 leader-attached workers cost 743.6 MB vs 521.3 MB standalone (0.70×, criterion ≥2× lower). No leader wiring exists in this skill; fat `grok -p` workers + this governor are the shipped topology. Full S0–S4 numbers and revisit conditions: `docs/superpowers/specs/2026-08-13-grok-swarm-leader-ram-design.md` §Spike results (repo agent-standard).

## Failure modes → recovery (high-traffic subset)

Full 30-edge matrix: `docs/2026-07-15-swarm-edgecases.md` + `bin/edge-matrix.cjs`. Filter: `swarm heal doctor --json | jq '.actions[]|select(.edgeId=="A1")'`.

| Symptom | Cause → action |
|---------|----------------|
| Hangs at start, empty log | Missing `--always-approve` → relaunch with it |
| `'--single <PROMPT>' cannot be used with '--prompt-file'` | Combined `-p` + `--prompt-file` → `--prompt-file` alone |
| Worktree guard STOP / `TOP==MAIN` (B1) | Raw `grok --worktree` or `--cwd`/`-r` misuse → always `dispatch-grok.sh --mode new` / Mode B `working_directory=$WT_PATH`; no auto-heal |
| `MODEL_SWITCH_INCOMPATIBLE_AGENT` | Wrong `-m` on resume → Mode B fresh, no `-r` |
| Reviewer plan-mode exits after 1 line | Rerun without plan mode + precomputed diff; verify `git status` unchanged |
| Builder edits outside owned files (B2) | Scope drift → `kill`, `dispatch update --status killed`, `grok worktree rm -f`, redelegate tight prompt |
| Worktree not in `grok worktree list` immediately | Poll ≤30s; `grok worktree db rebuild` if DB stale |
| Merge conflict (B3) | Ownership/`depends` violated or shared INDEX → mega union-retry safe paths else `merge_blocked` + builder; single: `git merge --abort` + delegate builder |
| Dispatch 0 bytes, no worktree (E5) | Harness reaped `cmd &` → foreground `Shell block_until_ms:0` no `&` |
| Dashboard dies on return (A3) | Same reaping → always `swarm dashboard --daemon` |
| Old swarm tasks on board (D2) | `swarm init` reused workspace → `swarm init --fresh` |
| Coordinator log frozen, builders done (A1) | `swarm heal doctor` edge A1 → `coordinator-stall-restart` (1/10m) or Mode B unstick |
| `pytest` missing symbols on MAIN but code in `src/` (F3) | Venv points at worktree — `cd MAIN && pip install -e '.[...]'`; in wt use `PYTHONPATH=$WT/src` |
| Mission "complete" but commits never pushed (G1) | Coordinator skipped per-merge push → template §C pushes after each merge+gates; `goal update --status completed` warns on `@{u}..HEAD > 0`; pre-push hook failure → follow its instructions, never `--no-verify` |
| Build tasks dispatched under `Scout N` labels (G2) | `--agent` label drives role flags (tools/sandbox/effort) → build/fix work always `Builder N`; scout labels only for read-only recon |
| Generated files dirty after merges (`convex/_generated`, Prisma, …) (G3) | Codegen output in no lease → assign generated dirs to the wire task at planning, or coordinator runs repo codegen post-merge and commits the drift |
| Archived board shows stale statuses (G4) | Coordinator skipped final `task update` + `board --sync` → completion step 0 syncs statuses; `goal update completed` now board-syncs mechanically |

Also cataloged: C4 REVISE×3 → `blocked`, C5 visual age >12m, C6 soft gates, D1 cancelled `depends_on`, D3 cycle, D4 peer lease clash, D5 `gates_only` visual, E1 capacity queue, E2 vite > `max_dev_servers`, F1/F2 double-check missing, F4 lightningcss SIGBUS — see edge doc + `docs/2026-07-15-fast-quality-bar.md`.

Mode B unstick (coordinator alive but frozen): verify worktree scope+gates → `git merge --no-ff` → board updates → reinstall editable if venv poisoned → `swarm coordinator stop && swarm coordinator start --resume --daemon` → confirm `task ready` next wave.

## Hot-hub adjudication — mandatory

Many features touching same multi-file hub (registry+schema+executor+locales+UI) must not be chained with `--depends`.

| ❌ Anti-pattern | ✅ Correct shape |
| --- | --- |
| One task per phase, each leasing full hub, chained via `depends` | Domain **packs** on NEW disjoint files parallel + one **wire** task owns hub |
| Runs as 1 builder | 3+ concurrent pack builders; wire serial, short |
| Scouts/reviewers once per phase | Scouts parallel at t0; reviewer+logger after wire |

Gate: `swarm check` fails on `serial_hub_chain` (≥3 non-terminal tasks sharing ≥3 hub files via depends chain). Escape: `swarm check --allow-serial-hub`. Full: `docs/2026-08-07-hot-hub-adjudication.md`. Checklist before launch: ready queue can have multiple builders post-scouts, hub in exactly one task’s `--files`, domain logic under new pack paths, `swarm check` green without `--allow-serial-hub`.

## Hard rules

1. Coordinator never edits app code — not merge conflicts. Dispatch/monitor/verify/`git merge` only.
2. Parent never babysits after autonomous launch — exit unless coordinator dead or user requests Mode B.
3. Disjoint file ownership, mechanically enforced. `task create` refuses overlaps; `swarm check` must pass. `--depends` not a license to serialize identical hubs (`serial_hub_chain`).
4. `--always-approve` on every headless `grok` run.
5. Model on every headless `grok` run — `grok-4.6` default (coordinator + workers). `dispatch-grok.sh`/`run-coordinator.sh` enforce; `GROK_SWARM_WORKER_MODEL`/`--model` override. Resume with same model or Mode B redispatch.
6. Parallel writes only via isolated git worktrees under `~/.grok/worktrees/…` via `dispatch-grok.sh --mode new` + cwd. Don’t treat raw `grok --worktree` as sufficient.
7. Every builder prompt is self-contained (`templates/builder-prompt.md`; HTML comments auto-stripped by dispatcher).
8. Every dispatch recorded (`swarm dispatch record`) with log/PID/base/sessionId.
9. Read-only reviewers: `--permission-mode plan` + prompt forbidding edits; confirm via `git status`.
10. Live monitoring mandatory for coordinator.
11. Fix loop bounded (~3 rounds via `-r`/`-c`); then `blocked` + escalate.
12. Merge only verified work; full gates on merged result before goal complete.
13. Mode C resume: always `--cwd "$WT_PATH"` with `-r`/`-c`; never `-r` without `--cwd`; never `-c/-r/-s` + `--worktree` on existing wt-* (use Mode D ` -w -r` only for intentional fork to fresh wt).
14. Post-dispatch sanity every dispatch (worktree + log growth ≤30s); dashboard/coordinator `--daemon` (not bare `&`).
15. Browser dashboard always on and current (`swarm dashboard --daemon --open` with `export SWARM_AGENT_NAME=Coordinator`); record every state change immediately.
16. Mandatory `/double-check` before `done` — builder writes `.grok-swarm/double-check/<taskId>.md` with `Double-check result: complete` (validated via file; `--json-schema` optional when `GROK_SWARM_WORKER_JSON_SCHEMA_MODE=replace`, but file gate applies regardless). Coordinators refuse merge without it. Schema: `templates/worker-done.schema.json` requires `doubleCheck`.
17. Dead dispatches self-heal — `dispatch list/reconcile`/dashboard/watch auto-reconcile dead-PID `running` → `done`/`failed` (log `end` vs quiet window); coordinator still verifies gates/visual/merge.
18. Visual harness ≠ product defect — unset proxies, auth on same origin, auth-only gaps are `BLOCKED` / `heal --auto-visual-pass` territory.
19. Five roles — Coordinator, Scout, Builder, Reviewer, Logger. Scouts/reviewers: no product edits. Loggers: only learnings/docs + INDEX.
20. Parallel megas — host capacity shared (`swarm capacity show`; defaults from `host-capacity.default.json`); file leases must not overlap peers. “4 coordinators” is not a Grok limit — raise ceilings in `host-capacity.json`.
21. No silent swarm knowledge — Logger must write learnings after every merge; `swarm learnings list`.

## Quick reference

```bash
# --- autonomous (default): parent plans, launches, exits ---
export SWARM_AGENT_NAME=Coordinator
swarm init <repo> --fresh --goal "..." --agents "Coordinator:coordinator,Builder 1:builder,..."
swarm task create --title T --owner B --files "a,b" --acceptance "..."
swarm check
swarm launch <repo>                          # dashboard + coordinator + heal daemons
swarm coordinator status | stop
swarm coordinator start --resume --daemon    # after pause / dead coordinator
swarm heal --daemon --interval 30            # self-monitor (also started by launch / mega run)
swarm heal doctor --json                     # dry diagnosis
swarm heal                                   # one-shot heal tick
swarm heal stop | status
swarm learnings list [--swarm ID] [--mega ID]
swarm learnings path
swarm pause --all   # multi-swarm safe; residual check required
swarm --version                                # audit date + capacity defaults + grok --version probe

# --- manual Mode B only: guard before dispatch waves ---
${CLAUDE_PLUGIN_ROOT}/skills/grok-swarm/bin/coordinator-guard.sh --repo "$REPO" --expect-clean

# --- swarm coordination ---
swarm init <repo> --fresh --goal "..." --agents "Coordinator:coordinator,Builder 1:builder,..."
swarm task create --title T --owner B --files "a,b" --acceptance "..." [--depends id] [--force]
swarm task ready [--json]
swarm check
swarm dispatch record --task <id> --agent <label> --worktree <n> --log <f> --pid <p> --base <ref>
swarm dispatch update --id <run> [--status done|failed|killed] [--session S] [--exit-code N]
swarm dispatch list [--status running] [--json] [--no-reconcile]
swarm dispatch reconcile [--dry-run] [--json]
swarm mail send --to <Agent|@all> --type <message|status|escalation|worker_done> --body "..."
swarm mail check --consume | swarm mail peek
swarm agent register --label "Builder 3" [--role builder]
swarm board [--sync] | swarm state | swarm help [topic]
swarm dashboard --daemon --open [--port 4599]  # detached; stop/status subcommands
swarm pause [--reason "..."] [--no-kill]
swarm resume

# --- Mode A new builder: ALWAYS dispatch-grok.sh (pre-creates git worktree + cwd isolation) ---
${CLAUDE_PLUGIN_ROOT}/skills/grok-swarm/bin/dispatch-grok.sh --mode new --repo "$REPO" --worktree wt-X --base "$BASE" \
  --agent "Builder 1" --prompt-file /tmp/grok-swarm-prompt.md --log /tmp/grok-swarm.log
# FORBIDDEN: grok --cwd "$REPO" --worktree wt-X

# --- grok headless: Mode B continue existing worktree (cwd = $WT_PATH) ---
dispatch-grok.sh --mode existing --worktree-path "$WT_PATH" --agent "Builder 1" \
  --prompt-file /tmp/grok-swarm-prompt.md --log /tmp/grok-swarm.log

# --- grok headless: builder (validated JSON result; cwd = worktree, not MAIN --worktree) ---
grok --prompt-file <f> --cwd <WORKTREE-PATH> \
     -m grok-4.6 --always-approve \
     --json-schema "$(cat templates/worker-done.schema.json)"   # implies json; optional — file gate still required

# --- grok headless: reviewer (read-only) ---
grok --prompt-file <f> --cwd <repo> --permission-mode plan \
     --disallowed-tools "search_replace,write" \
     -m grok-4.6 --always-approve --effort high

# --- grok headless: Mode C fix loop (resume INSIDE worktree) ---
grok --prompt-file <fix.md> --cwd <WORKTREE-PATH> -r <sessionId> \
     -m grok-4.6 --always-approve --no-subagents --max-turns 100 --fork-session
grok -c --prompt-file <fix.md> --cwd <WORKTREE-PATH> \
     -m grok-4.6 --always-approve   # no captured sessionId

# --- grok headless: Mode D fork session to NEW worktree (optional; -p still does not create the tree) ---
grok -w -r <sessionId> -p "..." -m grok-4.6 --always-approve

# NEVER: -r without --cwd when continuing existing wt-* work
# NEVER: --cwd ~/.grok/worktrees/... for Mode A new parallel builders

# --- heavy gates: ALWAYS through the semaphore (max_heavy_tools slots, default 3) ---
node ${CLAUDE_PLUGIN_ROOT}/skills/grok-swarm/bin/gate.cjs -- npm run typecheck
node ${CLAUDE_PLUGIN_ROOT}/skills/grok-swarm/bin/gate.cjs -- npx vitest run

# --- housekeeping ---
grok worktree list --json ; grok worktree rm <ids> -f
grok worktree gc --max-age 7d --dry-run   # without --max-age, gc expires nothing
grok du --json                            # ~/.grok disk (sessions + worktrees)
grok sessions list -n 10 ; grok sessions search "keyword" ; grok sessions delete <id>
grok models ; (cd <repo> && grok inspect --json) ; grok doctor --json ; grok --version
export XAI_API_KEY="xai-..." ; grok login --device-auth
```
