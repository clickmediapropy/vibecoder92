# grok-swarm — Command & Dispatch Reference

Two layers:
1. **`swarm` CLI** — coordination plumbing (board, file mail, event-sourced tasks, dispatch records, validation, **autonomous coordinator daemon**). Zero-dependency Node.
2. **`grok -p` dispatch recipes** — how the Coordinator launches/monitors Builder and Reviewer agents.

**Default:** a detached Grok CLI process is the Coordinator (`swarm coordinator start --daemon` / `swarm launch`). The parent agent plans tasks, launches, and exits. Manual parent-as-coordinator is Mode B (debug only). The coordinator never edits application code — only `swarm`, `dispatch-grok.sh`, `git merge`, and verify gates. Every code edit happens inside a builder `grok -p` run (see [usegrok](../usegrok/SKILL.md)).

Verified against **Grok CLI v1.0.3** (audited **2026-08-12**; previous 1.0.0 / 0.2.117). `grok update --check --json` → latest `1.0.3` no update. Default model **`grok-4.6`** (`grok models`; `grok-4.5` still listed). Swarm-relevant flags live in this file; full dump: [usegrok/GROK-CLI-REFERENCE.md](../usegrok/GROK-CLI-REFERENCE.md) (regenerate with `grok --help` if that file lags). Capacity defaults canonical in [`templates/host-capacity.default.json`](templates/host-capacity.default.json) and `bin/capacity.cjs`.

### Role dispatch flags (source of truth)

`dispatch-grok.sh` builds role-aware argv from `--agent` (substring match). **Workers never pass `--check` or `--best-of-n`** (both rejected on 1.0.3).

| Role | max-turns | no-subagents | disallowed-tools | sandbox (`GROK_SWARM_SANDBOX≠off`) | disable-web | json-schema replace |
| --- | --- | --- | --- | --- | --- | --- |
| scout / review / logger | yes | yes | `search_replace` | `read-only` | no | no |
| visual | yes | yes | `search_replace` | `workspace` | no | no |
| builder / worker / fix / default | yes | yes | none | `workspace` | if env=1 | if mode=replace |
| coordinator | 500 (daemon) | **no** | none | none | no | no |

| Env | Default | Effect |
| --- | --- | --- |
| `GROK_SWARM_WORKER_MAX_TURNS` | `100` | Worker `--max-turns` |
| `GROK_SWARM_WORKER_JSON_SCHEMA_MODE` | `off` | `replace` swaps streaming for `--output-format json --json-schema worker-done.schema.json` |
| `GROK_SWARM_WORKER_JSON_SCHEMA=1` | off | Compat → mode=replace |
| `GROK_SWARM_SANDBOX` | `off` | `workspace` enables role sandbox matrix |
| `GROK_SWARM_DISABLE_WEB_SEARCH` | `0` | Builders only — scouts/reviewers keep web for discovery/audit; builders disable to avoid prompt-injection drift |
| `GROK_SWARM_FORK_ON_FIX` | `1` | Resume uses `--fork-session` |
| `GROK_SWARM_WORKTREE_GC` | `1` | Mega cleanup runs `grok worktree gc --max-age …` (soft-fails with warning when `1`; set `0` to skip entirely) |
| `GROK_SWARM_WORKTREE_GC_MAX_AGE` | `7d` | CLI requires `--max-age` or gc expires nothing. Override duration here |

Spend telemetry: `log-analyze.cjs` parses streaming-json `end` events (`sessionId`, `usage`, `total_cost_usd`→`totalCostUsd`, `num_turns`→`numTurns`, `stopReason`) into dispatch records. Also handles `streaming-messages-json` (Anthropic wire format) `end` envelopes when `GROK_SWARM_WORKER_JSON_SCHEMA_MODE=replace` is off.

### New in 1.0.3 (delta from 1.0.0) — adoption notes for grok-swarm

| Flag / command | What it does | Swarm adoption |
| --- | --- | --- |
| Default model `grok-4.6` | CLI default; `grok-4.5` still listed | **Adopted:** wrappers default `-m grok-4.6`. Resume with same `-m` or Mode B fresh |
| `grok -p --worktree` is a no-op for tree creation | Help: “Headless (`-p`) does not create a worktree from this flag” | **Confirms Mode A:** `dispatch-grok.sh` pre-creates `git worktree` + process cwd. Never rely on raw `grok --worktree` in headless |
| `-r` / `--resume` by ID **or title** | Non-ID values match session titles in the current directory (case-insensitive; UUID-shaped values always mean IDs) | **Adopted as fallback:** prefer dispatch-recorded sessionId; if lost, `grok sessions list` then `-r "<title>"` with `--cwd "$WT_PATH"` |
| `grok doctor [--json]` | Terminal/clipboard/color/input diagnostic without starting Grok | **Adopted:** optional pre-flight (`grok doctor --json`). Not a swarm gate |
| `grok du` / `disk-usage` (`--json`) | `~/.grok` disk: top-level dirs + each worktree size/age/label | **Adopted:** host hygiene before mega / cleanup. `grok du --json` then `grok worktree gc --max-age 7d --dry-run` |
| `grok worktree gc --max-age` | Without `--max-age`, gc expires nothing; visits only registry-tracked trees | **Adopted:** mega cleanup passes `--max-age ${GROK_SWARM_WORKTREE_GC_MAX_AGE:-7d}`. Swarm `wt-*` trees are often untracked — `swarm cleanup` still owns those |
| `--fullscreen` / `--minimal` | TUI screen mode | Ignore in swarm (headless) |
| `--check` / `--best-of-n` | Still absent | Keep the never-pass rule (verified 1.0.3) |

1.0.0 items already adopted (unchanged): `--tools` allowlist for scouts/reviewers, `--sandbox` opt-in, workers `--no-memory`, `grok inspect --json`, `grok trace`/`export` on failed sessionId, `streaming-json` (not `streaming-messages-json`).

Official headless docs: [xAI Headless & Scripting](https://docs.x.ai/build/cli/headless-scripting). Headless sessions live in `~/.grok/sessions`.

---

## Part 1 — `swarm` CLI

`bin/swarm` (POSIX sh) → `bin/swarm.cjs` (Node). Add `bin/` to `PATH`, or call `node ${CLAUDE_PLUGIN_ROOT}/skills/grok-swarm/bin/swarm.cjs`. `swarm help [topic]` prints usage per subcommand.

**Identity:** every command reads `$SWARM_AGENT_NAME` (sender of mail, actor on events/dispatches). Always export it:
```bash
export SWARM_AGENT_NAME="Coordinator"   # or "Builder 1", "Reviewer", ...
```

**Workspace:** lives at `<repo>/.grok-swarm/`. Per-swarm state is under `swarms/<id>/` (board, inbox, events, dispatches). A repo-level `registry.json` lists swarms; `dashboard.pid` and `dashboard.log` sit at the `.grok-swarm/` root (one browser daemon serves all swarms).

**Swarm selection:** `--swarm <id>` or `export SWARM_ID=<id>`. Auto-selects when exactly one swarm is registered; errors when 2+ and ambiguous. Set default: `swarm swarms use <id>`.

```bash
swarm swarms list [--json]
swarm swarms use <id>
swarm swarms archive <id>
swarm migrate [--json]          # legacy root layout -> swarms/default/
swarm conflicts [--json]        # cross-swarm file overlap warnings
swarm --swarm feature-x task list  # global flag before subcommand
```

Legacy workspaces (events at `.grok-swarm/` root) auto-migrate to `swarms/default/` on first command.

### init
```bash
swarm init /path/to/repo \
  --goal "One-sentence swarm goal" \
  --agents "Coordinator:coordinator,Builder 1:builder,Builder 2:builder,Reviewer:reviewer"
```
Scaffolds `<repo>/.grok-swarm/`: `SWARM_BOARD.md` (from `templates/SWARM_BOARD.md`, with sync markers), `agents.json`, `inbox/`, `nudges/`, `transcript/`, `plan/events/`, `dispatches/`. Seeds a `goal-primary` if `--goal` is given. Idempotent: never overwrites an existing board/agents file.

### mail
```bash
# Send (types: message | status | escalation | worker_done | swarm_complete)
swarm mail send --to "Builder 1" --type message --body "Task assigned: ..."
swarm mail send --to @all --type status --body "Phase 1 starting"   # broadcasts to every agents.json label except sender

# Check your own inbox ($SWARM_AGENT_NAME)
swarm mail check              # print, leave messages
swarm mail check --consume    # print, then delete (worker loops)
swarm mail check --inject     # print with header/footer, consumes (prompt injection)
swarm mail check --json       # machine-readable (combine with --consume to drain)

# Cheap polling — non-consuming, exit code signals state
swarm mail peek               # exit 0 = mail waiting, exit 1 = empty
swarm mail peek --json
```
Mail is JSON files under `inbox/<label>/`; every send is copied to `transcript/` and drops a `nudges/<label>.txt` marker. Timestamps are epoch milliseconds. `@all` requires registered agents.

### task / goal (event-sourced)
```bash
swarm goal create --title "Build the feature" [--status active]
swarm goal update --id primary --status completed

swarm task create \
  --title "Domain A: …" \
  --owner "Builder 1" \
  --files "path/to/module_a,path/to/module_a_test" \
  --acceptance "<this repo's gates>; behavior X" \
  [--depends task-xxxx] [--goal primary] [--force]

swarm task update --id task-xxxx --status building --note "started"
swarm task update --id task-xxxx --status done --note "gates green; 2 files changed"
swarm task update --id task-xxxx --status blocked --blocked "needs product decision"

swarm task list [--owner "Builder 1"] [--status building] [--json]
swarm task ready [--json]     # dispatchable NOW: open/assigned AND all depends-on tasks done
```
Status lifecycle: `open → assigned → planning → building → review → done` (or `blocked`/`cancelled`). State is replayed from `plan/events/*.json` — each write is a new event file, so concurrent agents never clobber each other.

**Overlap guard:** `task create`/`task update --files` **refuses** owned-file sets that intersect another active (non-done/cancelled) task, unless the overlapping task is listed in `--depends` (sequenced) or you pass `--force`. This mechanizes the disjoint-ownership rule.

**Hot-hub rule:** `--depends` must **not** chain 3+ tasks that all still share ≥3 hub files (phase monoliths). That is a `serial_hub_chain` — packs on NEW files + one wire task. See `docs/2026-08-07-hot-hub-adjudication.md`.

### check (board validation)
```bash
swarm check          # human output; exit 0 = clean
swarm check --json   # {"ok":bool,"problems":[{kind,tasks,files?,message}]}
swarm check --allow-serial-hub   # legacy escape hatch only
```
Detects: parallel file overlaps without a `depends-on`, references to missing dependency tasks, dependency cycles, and **`serial_hub_chain`** (≥3 active tasks sharing ≥3 hub files via depends_on — one-builder-at-a-time anti-pattern). Run before every dispatch wave.

### dispatch (run records)
One record per builder/reviewer `grok` run, stored as `dispatches/*.json`:
```bash
swarm dispatch record --task task-xxxx --agent "Builder 1" \
  --worktree wt-domain-a --worktree-path /path/to/wt \
  --log /tmp/grok-swarm-a.log --pid 12345 --base "$BASE_REF"

swarm dispatch update --id run-xxxx --session <sessionId>     # once known (from json output)
swarm dispatch update --id run-xxxx --status done --exit-code 0
swarm dispatch update --id run-xxxx --status killed --note "scope drift"

swarm dispatch list [--task T] [--agent A] [--status running] [--json] [--no-reconcile]
swarm dispatch reconcile [--dry-run] [--json]
```
Statuses: `running | done | failed | killed | paused`. This is where logs, PIDs, worktrees, and sessionIds live — the fix loop reads `sessionId` from here instead of the coordinator's memory.

**Auto-reconcile (2026-07-14):** if a dispatch stays `running` after the process exits, the dashboard shows multi-hour `(exited?)` ghosts and looks “stuck.” `dispatch list` (unless `--no-reconcile`), `dispatch reconcile`, and every dashboard/watch poll call `reconcileDeadDispatches`:
- PID dead + streaming-json `"type":"end"` → `done` (exit 0), capture `sessionId` if missing
- PID dead + error / no end after ~10s log quiet → `failed`

Does **not** change task status — coordinator still runs gates, visual, merge.

### heal (self-monitor agent)

Mechanical (no LLM) agent that keeps the board honest while Grok coordinators think.

**Edge tags:** doctor/heal actions may include **`actions[].edgeId`** (e.g. `A1` stall-restart, `A2` dead coord, `A6` force-pass eval, `C5` visual age-pass, `D1` cancelled-dep scrub) from `bin/edge-matrix.cjs`. Filter: `jq '.actions[]?|select(.edgeId=="A1")'`. Full matrix: [`docs/2026-07-15-swarm-edgecases.md`](docs/2026-07-15-swarm-edgecases.md). Quality bar: [`docs/2026-07-15-fast-quality-bar.md`](docs/2026-07-15-fast-quality-bar.md).

```bash
swarm heal doctor --repo "$REPO" --json     # dry diagnosis (actions[].type, actions[].edgeId)
swarm heal --repo "$REPO"                   # one-shot heal tick
swarm heal --daemon --interval 30 --repo "$REPO"
swarm heal status|stop --repo "$REPO"
# optional: --auto-visual-pass  (force-pass only via visual-policy eligibility)
#           --restart-mega      (restart dead mega meta daemon)
#           --no-restart-daemons / --no-restart-coordinators

# Detect recipes (see edgecases doc for full set)
swarm heal doctor --repo "$REPO" --json | jq '.actions[]?|select(.type|test("stall"; "i"))'   # A1
swarm heal doctor --repo "$REPO" --json | jq '.actions[]?|select(.edgeId=="A1")'
swarm capacity show --repo "$REPO"   # E2 vite / capacity
```

| Flag / concept | Behavior |
|----------------|----------|
| `swarm heal --auto-visual-pass` | Force-pass only if visual-policy eligibility (auth BLOCKED / aged BLOCKED + gates+DC green); never product REVISE high |
| `actions[].edgeId` (doctor JSON) | Matrix ID on heal actions when tagged (Task 2); use with `.type` / `.healAction` for operator filters |

**What it heals each tick:**
1. Dead-PID dispatches (`dispatch-reconcile`)
2. Dead/missing dashboard → restart `(A3)`
3. Dead/missing coordinator on swarms with open tasks → `coordinator start --resume --daemon` `(A2)`; stall mid-thought after builders done → rate-limited restart `(A1)`
4. Visual `PASS` artifact not in `review-artifacts/` → copy promote
5. Auth-only visual `BLOCKED` / aged no-result (optional `--auto-visual-pass`) → write gate PASS with `healer: true` only when visual-policy says eligible `(C2/C5/A6)`
6. Cancelled/bad `depends_on` scrub `(D1)`; mega daemon missing/dead (optional `--restart-mega`) `(A4)`

Journal: `.grok-swarm/heal/last.json`, `heal.log`, daemon pid `healer.pid`.
Started automatically by `swarm launch` and `swarm mega run --daemon` (opt out: `--no-healer`).

### agent
```bash
swarm agent register --label "Builder 3" [--role coordinator|builder|reviewer|scout|logger]
swarm agent list [--json]
```
Adds/updates entries in `agents.json` after init — keeps `@all` broadcasts working for late-added builders. **Roles:** coordinator (orchestrate), scout (discover), builder (implement), reviewer (audit/visual), **logger** (compound learnings after merge).

### learnings (Logger output)
```bash
swarm learnings path [--repo PATH] [--json]
swarm learnings list [--repo PATH] [--swarm ID] [--mega ID] [--json]
```
Preferred root: `docs/solutions/` if present (compound-engineering style), else `docs/learnings/`, else `.grok-swarm/learnings/`. Logger also writes `.grok-swarm/learnings/by-swarm/<id>/SUMMARY.md`.

### capacity (host-shared across parallel megas)
```bash
swarm capacity show [--repo PATH] [--json]
swarm capacity set --max-coordinators 10 --max-builders 30 --max-reviewers 15 --max-scouts 10
```
Live free slots = host ceiling − usage across **all** active megas. Second mega only fills remaining slots; does not reset to a full private pool.

| Command | Behavior |
|---------|----------|
| `swarm capacity show` | Includes live dev server count when available |

### gate (heavy-tool semaphore)
```bash
node <skill>/bin/gate.cjs [--slots-dir D] [--max N] -- <cmd> [args...]
node <skill>/bin/gate.cjs -- npm run typecheck        # typical builder usage
```
Slot semaphore for heavy gate subprocesses (`tsc`, `vitest`, `npm install`, builds — ~1 GB RSS each; these, not the grok processes, trigger low-memory auto-pauses). Blocks until one of `max_heavy_tools` slots frees (host capacity, default **3**), runs the command with inherited stdio, propagates its exit code, releases on exit/SIGINT/SIGTERM. Slots are `slot-<i>.pid` files under `<nearest .grok-swarm walking up from cwd>/gate-slots/` — for worktree builders that is whatever `.grok-swarm/` sits above `~/.grok/worktrees/` (a stray `~/.grok-swarm/` counts; the 2026-08-13 live proof resolved there), and `/tmp/grok-gate-slots` only when the entire ancestor path has none. The capacity file resolves the same way, so a repo's `max_heavy_tools` override does not reach worktree builders — pass `--max N` or `--slots-dir MAIN/.grok-swarm/gate-slots` explicitly to pin pool and ceiling. Claims are atomic `O_EXCL` creates; dead-holder and poisoned (empty/invalid, >10s old) slots are reclaimed. Advisory — enforced by prompt (`templates/builder-prompt.md`), like file leases.

### Leader mode verdict (spiked 2026-08-13 — not shipped)

`bin/leader-spike.sh <repo> [n]` measures Jcode-style single-server hosting on `grok agent leader`. Result on grok 1.0.3 (16 GB Mac, 8 workers, `grok-4.6`):

| Gate | Result |
|------|--------|
| S0 baseline: 8 × standalone `grok -p` | 521,296 KB aggregate RSS mid-flight |
| S1 RAM: 8 × `--leader` clients + leader | 743,616 KB (leader 44,032 KB) → **0.70×, FAIL** (criterion ≥2× lower) — clients are full-weight |
| S1 sessions | 8/8 distinct sessionIds (multiplexing works) |
| S2 mixed cwd (MAIN + worktree, one leader) | pass |
| S3 client `kill -9` mid-tool | leader **keeps executing** → any future wiring needs `leader_pause_mode: "leader"` |
| S4 `--tools read_file,grep,list_dir` via leader | pass (write blocked) |

Decision matrix row **S1 fail → no leader wiring**: fat `grok -p` workers + the gate semaphore + capacity ceilings are the shipped topology. Revisit only if a future Grok CLI ships thin leader clients. Full record: the leader-mode spike notes.

### board / state
```bash
swarm board          # rendered goal + tasks + agents + running dispatches
swarm board --sync   # rewrite SWARM_BOARD.md sections between <!-- swarm:tasks:start/end --> and <!-- swarm:done:start/end -->
swarm state          # full JSON state {goals, tasks}
```

### pause / resume (safe halt + restore)
```bash
swarm pause --all [--reason "..."] [--no-kill] [--json]
swarm resume [--json]
```
`pause` SIGTERMs every `running` dispatch's PID (skip with `--no-kill`), marks those dispatch records `paused`, and writes `pause.json` capturing per run: dispatchId, taskId, agent, worktree(+path), sessionId, log file, base ref, and the kill outcome. Events, mailboxes, grok sessions, and worktrees are untouched — nothing is lost. While paused: `dispatch record` refuses (override with `--force`), `task ready` prints a warning, `board` and the dashboard show a paused banner, and a second `pause` is refused.

`resume` archives the manifest to `pause-history/` and prints one relaunch command per interrupted builder whose task is still unfinished:

- **Mode C** when `sessionId` was recorded: `grok -p "Resume..." --cwd <WT_PATH> -r <sessionId> -m grok-4.6 --always-approve`
- **Mode B** when no session: `grok -c -p "Resume..." --cwd <WT_PATH> ...` (shell cwd = worktree in reaping harnesses)

The coordinator relaunches each command (foreground Shell in Cursor: `block_until_ms: 0`, no `&`), records new dispatches, and re-enters the monitoring loop. `--json` gives the machine-readable resume plan.

### coordinator (autonomous Grok CLI daemon)
```bash
swarm coordinator start [--daemon] [--resume] [--session ID] [--print-only] [--foreground]
swarm coordinator status [--json]
swarm coordinator stop
```
Renders `templates/coordinator-prompt.md` → `.grok-swarm/coordinator-prompt.md`, then runs `bin/run-coordinator.sh` (long-lived `grok --prompt-file … --max-turns 500 --effort high`). Default is **detached** (`coordinator.pid` + `coordinator.log` at the registry root). `--resume` continues from a prior coordinator `sessionId` when known and tells the prompt not to re-init. `--print-only` is for dry-runs/tests.

Parent agents should **not** re-enter the monitor loop while this daemon is alive.

### mega (hierarchical multi-swarm)
```bash
# plan.json — see templates/mega-plan.schema.json and docs/2026-07-14-mega-swarm-design.md
swarm mega propose --repo /path/to/repo --goal "…" --roots src/features --out plan.json
swarm mega write-plan --plan plan.json --repo /path/to/repo
swarm mega check --id my-mega [--json]
swarm mega status [--id my-mega] [--json]
swarm mega watch [--id my-mega] [--repo PATH] [--json]   # ≡ swarm watch <mega-id>
swarm watch <mega-id> [--repo PATH] [--json] [--loop]    # mega status + coordinator status --all
swarm mega launch --id my-mega [--force] [--dry-run] [--no-coordinator]
swarm mega run --id my-mega --daemon [--interval 20] [--auto-merge] [--to-main] [--gates "…"] [--auto-cleanup]
# auto-merge: on integrate conflict, union-retries INDEX/learnings; hard conflicts → merge_blocked (daemon stays up)
# swarm mega merge --id <mega> [--to-main] [--no-dispatch-resolver]
swarm mega run --id my-mega --status | --stop
swarm mega tick --id my-mega [--force-visual-pass] [--json]
swarm mega visual check|pass --id my-mega --sub inbox
swarm mega mark --id my-mega --sub inbox --status done   # hard visual gate if visual_review / tier requires it
swarm mega merge --id my-mega [--to-main] [--gates "cmd"] [--skip-visual-gate]
swarm mega cleanup --id my-mega --full
swarm mega doctor --expect-clean --repo /path/to/repo
swarm cleanup --swarm <sub-swarm-id>
```

| Flag / concept | Behavior |
|----------------|----------|
| `visual_tier` on mega plan subswarm | `full` \| `smoke` \| `gates_only` |
| `swarm cleanup --swarm <id>` | Also kills vite PIDs whose cmdline includes removed worktrees |
| `swarm capacity show` | Includes live dev server count when available |

Capacity defaults (host-shared, micro-pack): max_coordinators **16**, max_builders **30**, max_reviewers **15**, max_scouts **10**, max_visual_reviewers **8**, max_dev_servers **10** — set via `swarm capacity set` / `host-capacity.json`. `mega propose` targets ~**20** packs, **1 builder**, scout only on `visual_tier=full`. Parallel megas share free slots; cross-mega lease overlaps are refused. Roles: coordinator, scout, builder, reviewer, logger. File leases refuse overlapping subswarms without `depends_on`. Integrate: `mega merge` → `swarm/integrate/<id>` → optional main. Dashboard: `GET /api/mega`. Floor mode: `"floor": true` on a subswarm skips Grok coordinator (meta tick dispatches). After mission: **cleanup --full**.

**Worktree seed:** `dispatch-grok.sh` copies paths from `.grok-swarm/worktree-seed.json` or `templates/worktree-seed.default.json` (`.env.local`, `.env`, playwright auth) MAIN → worktree after create.

**Visual reviewer:** `templates/visual-reviewer-prompt.md` + agent-browser; findings redispatch builders. Subswarms may set `visual_tier` (`full` / `smoke` / `gates_only`) so pack visual depth matches surface area.

**Mandatory /double-check:** builders and visual reviewers follow `{{SKILL_ROOT}}/../double-check/SKILL.md`. Builders write `.grok-swarm/double-check/<taskId>.md` with `Double-check result: complete` before `worker_done`. `worker-done.schema.json` requires `doubleCheck`. Coordinators refuse merge without it (redispatch). Protocol template: `templates/double-check-protocol.md`.

### launch (plan-then-exit entrypoint)
```bash
# After init + task create:
swarm launch /path/to/repo
# Optional: also init in one shot (still create tasks before coordinator can dispatch):
swarm launch /path/to/repo --fresh --goal "..." --agents "Coordinator:coordinator,Builder 1:builder"
swarm launch --no-coordinator          # dashboard only
swarm launch --no-dashboard            # coordinator only
```
Chains `dashboard --daemon --open` + `coordinator start --daemon`. Prints an explicit "parent should EXIT" reminder.

### dashboard (mission-control UI)
```bash
export SWARM_AGENT_NAME=Coordinator
swarm dashboard --daemon --open --cwd "$REPO"   # detached server; --open launches Chrome
swarm dashboard status | swarm dashboard stop     # verify / stop
```
Serves `templates/dashboard.html` (static template) at `http://127.0.0.1:<port>/` — the `dashboard/js/*.js` files (app.js, mission-root.js, etc.) are controllers that render the template, not a duplicate source. HTTP API:
- `GET /api/state?swarm=<id>` — v2 payload (`apiVersion: 2`, stats, kanban data, `runningDispatches`, `boardHealth`, `resumePlan`, …)
- `GET /api/state?view=overview` — all swarms summary
- `GET /api/swarms` — registry list
- `GET /api/log-tail?swarm=<id>&dispatch=<run-id>&format=structured|plain&lines=80`

Pidfile: `.grok-swarm/dashboard.pid` (repo-scoped, not per-swarm). `--port 0` picks a free port (foreground only). Localhost only.

### watch (terminal live view — no HTTP daemon)
```bash
swarm watch                    # live refresh every 2s (TTY)
swarm watch --once             # single snapshot (scripts / SSH without browser)
swarm watch --once --json      # same payload as /api/state v2
swarm watch --tail-log 5       # append last N log lines per running dispatch
swarm watch --all              # all swarms when 2+ registered
```
Non-TTY auto-prints one snapshot. Supersedes `watch -n2 swarm board` for operator monitoring.

### SSH workflow
```bash
# Pane 1: coordinator dispatches
cd ~/repos/myapp && swarm dashboard --daemon --open   # optional if browser available

# Pane 2: terminal watch (no browser)
cd ~/repos/myapp && swarm watch
```

---

## Part 2 — Grok dispatch recipes (Coordinator runs these)

### Dispatch modes A/B/C/D (canonical)

| Mode | When | Invocation |
|------|------|------------|
| **A — New parallel builder** | First dispatch | `dispatch-grok.sh --mode new` — **pre-create** `git worktree` + process cwd. Do **not** pass `grok --worktree` (1.0.3: `-p` does not create a worktree from that flag) |
| **B — Existing worktree** | Pause/resume, partial work, guard STOP recovery | Shell cwd = `$WT_PATH`; omit grok `--cwd` and `--worktree` |
| **C — Fix loop / session resume** | Same builder + worktree + context | `--cwd "$WT_PATH" -r "$SESSION" -m grok-4.6` (`-r` = ID or title; prefer recorded sessionId) |
| **D — Fork to new worktree** | Intentional xAI fork only (interactive / non-`-p`) | `grok -w -r "$SESSION" -p "..."` |

Use `${CLAUDE_PLUGIN_ROOT}/skills/grok-swarm/bin/dispatch-grok.sh` to print/run Mode A/B without copy-paste errors.

**Footguns:**
- `--cwd` to `~/.grok/worktrees/...` does **not** reliably set shell cwd for tool runs — use Mode B (`working_directory` = worktree).
- **Never** `-r` without `--cwd "$WT_PATH"` when continuing existing `wt-*` work.
- **Never** combine `-c`/`-r`/`-s` with `--worktree` on an **existing** tree (Mode C, not `-w -r`).

### Base builder run
```bash
grok --prompt-file /tmp/grok-swarm-<slug>-prompt.md \
  --cwd /path/to/repo \
  -m grok-4.6 \
  --always-approve
```
Mandatory: a single-turn prompt via `--prompt-file <path>` (preferred — no shell-quote mangling) or `-p "<prompt>"` — **never both**: `--prompt-file` replaces `-p`; combining them errors with `'--single <PROMPT>' cannot be used with '--prompt-file'`. Also mandatory: `--always-approve` (or it hangs on the first tool prompt), `--cwd`, and the **role model**: **coordinator** `-m grok-4.6`; **workers** (builders/reviewers/scouts/loggers/visual/fix/resume) `-m grok-4.6`. Wrappers enforce defaults (`run-coordinator.sh` → 4.6; `dispatch-grok.sh` → 4.6 (or GROK_SWARM_WORKER_MODEL)).

### Builder prompts — use the template
Fill `templates/builder-prompt.md` placeholders (`{{BUILDER_LABEL}}`, `{{TASK_ID}}`, `{{SWARM_ID}}`, `{{SWARM_BIN}}`, `{{OWNED_FILES_LIST}}`, `{{TASK_DESCRIPTION}}`, `{{ACCEPTANCE_CRITERIA}}`, `{{VERIFICATION_COMMANDS}}`) and save to `/tmp/`. The template already contains the repo-alignment block, the hard scope boundary, and the swarm mail/task protocol. A `grok -p` run cannot see this conversation or the board — the prompt is its entire world.

### Parallel builders (Mode A — write isolation via worktrees)

```bash
REPO=/path/to/repo
BASE=$(git -C "$REPO" rev-parse HEAD)

# Preferred wrapper (no trailing & — harness runs foreground)
${CLAUDE_PLUGIN_ROOT}/skills/grok-swarm/bin/dispatch-grok.sh --mode new \
  --repo "$REPO" --worktree wt-domain-a --base "$BASE" \
  --agent "Builder 1" --prompt-file /tmp/grok-a.md --log /tmp/grok-a.log

# FORBIDDEN in headless 1.0.3: grok --cwd "$REPO" --worktree wt-domain-a
# (`-p` does not create a worktree from --worktree; session can land on MAIN)
```

Poll the printed `WORKTREE_PATH=` from `dispatch-grok.sh` (and `git -C "$WT_PATH" rev-parse --show-toplevel`) up to **30s**. `grok worktree list` only shows **registry-tracked** trees — Mode A git worktrees are often `tracked: false`.

`--base` on `dispatch-grok.sh --mode new` pins every parallel builder to the **same** ref so merges are clean. Only run concurrent write builders whose owned files are disjoint (`swarm check` must pass first).

### Continue existing worktree (Mode B)

```bash
WT_PATH=~/.grok/worktrees/repos-myrepo/wt-domain-a

${CLAUDE_PLUGIN_ROOT}/skills/grok-swarm/bin/dispatch-grok.sh --mode existing \
  --worktree-path "$WT_PATH" --agent "Builder 1" \
  --prompt-file /tmp/grok-a.md --log /tmp/grok-a.log
# Cursor: set Shell working_directory=$WT_PATH, block_until_ms=0, no &
```

### Structured worker_done (validated JSON result)
`--json-schema` constrains the final output (implies `--output-format json`). Use the shipped schema:
```bash
SCHEMA=$(cat ${CLAUDE_PLUGIN_ROOT}/skills/grok-swarm/templates/worker-done.schema.json)
# Prefer dispatch-grok.sh; GROK_SWARM_WORKER_JSON_SCHEMA_MODE=replace swaps streaming for --json-schema
SWARM_AGENT_NAME="Builder 1" grok --prompt-file /tmp/grok-a.md \
  --cwd "$WT_PATH" \
  -m grok-4.6 --always-approve \
  --json-schema "$SCHEMA" | tee /tmp/grok-a.json

SESSION_ID=$(jq -r '.sessionId' /tmp/grok-a.json)
swarm dispatch update --id run-xxxx --session "$SESSION_ID"
```
Streaming vs schema: use streaming-json for live monitoring of long runs; use `--json-schema` when you want one validated result object. For long builders, run streaming-json in the background and have the builder also report via `swarm mail send --type worker_done` (the template instructs this).

### Live monitoring loop (never fire-and-forget)
Every ~15–30s:
```bash
swarm dispatch list --status running
tail -n 20 /tmp/grok-swarm-<slug>.log        # parse "type": text|thought|end|error
SWARM_AGENT_NAME=Coordinator swarm mail check --consume
git -C <worktree-path> status --short        # compare against the task's owned files
```
Intervene: out-of-scope edits or a wedged run → `kill <pid>` (from the dispatch record), `swarm dispatch update --id <run> --status killed --note "..."`, discard the worktree, redelegate tighter. A hang at start with an empty log almost always means a missing `--always-approve`.

### Reviewer — real read-only via plan mode
`--permission-mode plan` blocks edit tools at the CLI level (don't rely on the prompt alone):
```bash
SWARM_AGENT_NAME="Reviewer" grok --prompt-file /tmp/grok-review.md \
  --permission-mode plan \
  --cwd /path/to/repo -m grok-4.6 --always-approve --effort high
git -C /path/to/repo status    # MUST be unchanged
```
Belt-and-suspenders: `--deny` write rules or `--tools "read_file,grep,list_dir"`. The reviewer prompt must still say "Do NOT modify, create, or delete files" and ask for a PASS/REVISE verdict per task.

**Known limitation (still on 1.0.3):** headless plan-mode runs sometimes end after one intro line without performing the review. Fallback: rerun without `--permission-mode plan` with a strict read-only prompt (precompute `git diff > /tmp/review.patch` for it to read), then verify read-only after the run by comparing `git status`/`git diff` before vs after.

### Fix loop (Mode C — resume the same session)
```bash
WT_PATH=$(grok worktree list --json | jq -r '.[] | select(.name=="<wt-name>") | .path')
SESSION=$(swarm dispatch list --task task-a --json | jq -r '.[-1].sessionId')
grok -p "Fix: [exact issues from verification]" \
  --cwd "$WT_PATH" -r "$SESSION" -m grok-4.6 --always-approve

# No captured sessionId? Prefer -c for that cwd, or -r "<session title>" (1.0.3 title match):
grok -c -p "Fix: ..." --cwd "$WT_PATH" -m grok-4.6 --always-approve
# NEVER -r without --cwd when continuing existing wt-* work
# On MODEL_SWITCH_INCOMPATIBLE_AGENT: fresh Mode B, no -r
```
Cap at ~3 fix rounds, then `swarm task update --status blocked` and escalate. `grok sessions list -n 10` finds IDs/titles you lost.

### Merge + cleanup
```bash
grok worktree list --json                               # branch + path per worktree
git -C "$REPO" merge --no-ff <wt-branch-a> -m "swarm: merge domain A (task-a)"
git -C "$REPO" merge --no-ff <wt-branch-b> -m "swarm: merge domain B (task-b)"
# conflict? git merge --abort → delegate resolution to a builder via grok -p (coordinator never edits)
# then: full repo verification gate on the merged result
grok worktree rm <ids> -f
grok du --json
grok worktree gc --max-age 7d --dry-run   # then drop --dry-run; without --max-age, gc expires nothing
```

### Headless command cheat sheet (1.0.3)

**Prompt source (pick one):** `-p "..."` OR `--prompt-file <path>` (preferred) OR `--prompt-json`. Never `-p` + `--prompt-file`.

**Mandatory on every swarm `grok` run:** `--always-approve`, correct `--cwd`, and role model (`grok-4.6` coordinator / `grok-4.6` workers). Workers also pass `--no-memory` for isolation (coordinator keeps default cross-session memory).

**Output:** `--output-format plain|json|streaming-json|streaming-messages-json` (swarm uses `streaming-json` ACP updates for live monitor; `streaming-messages-json` needs `--include-partial-messages` for deltas); `--json-schema` for validated worker_done (via `GROK_SWARM_WORKER_JSON_SCHEMA_MODE=replace`).

**Sessions:** `-c` continue, `-r <id-or-title>` resume (UUID-shaped → ID; else title match in cwd), `-s <uuid>` new named session; list via `grok sessions list -n 10`. Mode C fix loop: `--prompt-file` + `--cwd <worktree-path> -r <id> --fork-session --max-turns --no-memory` — never `-r` without `--cwd` on existing trees. Mode D fork: `grok -w -r <id>` (new worktree only; `-p` still does not create the tree); remote D adds `--restore-code` to restore snapshot codebase (local stays conversation-only).

**Worktrees:** Mode A uses git worktree + process cwd. **Do not** pass `grok --worktree` on headless launch (1.0.3: `-p` does not create a worktree from that flag). Manage via `git worktree` + `swarm cleanup`; `grok worktree list|show|rm` for registry-tracked trees; `grok worktree gc --max-age 7d` (without `--max-age`, gc expires nothing). Disk: `grok du --json`.

**Read-only roles:** `dispatch-grok.sh` passes `--tools "read_file,grep,list_dir"` (strict) or `--disallowed-tools search_replace` + `--no-memory`. Optional `--permission-mode plan` for reviewers.

**Tuning:** `--effort` (alias `--reasoning-effort`), `--max-turns`, `--no-subagents`, `--rules`, `--sandbox`, `--disable-web-search`, `--system-prompt-override`, `--tools`. **Do not pass `--check` or `--best-of-n`** — both rejected on 1.0.3.

**CI auth:** `XAI_API_KEY`, `grok login --device-auth`; suppress updates via `[cli] auto_update = false` in `~/.grok/config.toml`.

Full tables: [GROK-CLI-REFERENCE.md](../usegrok/GROK-CLI-REFERENCE.md) (may lag; `grok --help` wins). Subcommands: `grok worktree`, `grok sessions`, `grok inspect`, `grok models`, `grok export`, `grok doctor`, `grok du`.

### Pre-flight / auth
```bash
grok --version               # expect >= 1.0.3
grok models                  # default grok-4.6; grok-4.5 still listed
cd <repo> && grok inspect --json
grok update --check --json   # 1.0.3 latest stable as of 2026-08-12
grok doctor --json           # terminal/clipboard diagnostic
grok du --json               # ~/.grok disk before mega / cleanup
export XAI_API_KEY="xai-..." # headless/CI auth; or grok login --device-auth
```

---

## Failure modes

**Full operator matrix (30 edges A1–F3):** [`docs/2026-07-15-swarm-edgecases.md`](docs/2026-07-15-swarm-edgecases.md) · catalog `bin/edge-matrix.cjs` · high-traffic recovery also in [SKILL.md § Failure modes](SKILL.md#failure-modes--recovery). Quality bar: [`docs/2026-07-15-fast-quality-bar.md`](docs/2026-07-15-fast-quality-bar.md).

| Edge | Symptom | Cause → action |
|------|---------|----------------|
| — | **Cursor: coordinator implemented directly** | Coordinator used `Write`/`StrReplace`/`Task` on main instead of `dispatch-grok.sh` → `git revert` coordinator commits on main; `swarm pause`; redispatch Mode A/B builders in worktrees; `coordinator-guard.sh --expect-clean`; re-read SKILL.md § Cursor Coordinator Contract |
| **B1** | Main repo dirty / TOP==MAIN before merge | Isolation fail or coordinator edits on default branch → STOP; audit MAIN; redispatch into worktree; never merge until clean |
| **A1** | Tasks in review; coordinator log frozen | `swarm heal doctor --json` (filter `edgeId=="A1"` / stall type) → heal stall-restart or Mode B unstick (merge + board + coord restart) |
| **A2** | Autonomous coordinator dead / max-turns exit | `coordinator start --resume --daemon`; check `coordinator.log` |
| **C1** | Visual Cargando / Convex WS 1006 | Unset `http_proxy`/`https_proxy`/`ALL_PROXY` for vite + browser |
| **C2** | Login OK, `/app/*` always redirects | Re-auth on **same** origin as `APP_BASE_URL`; or `mega visual pass` / heal auto-visual-pass when policy allows — not endless product REVISE |
| **E2** | Live vite ≫ host cap | `swarm capacity show --repo "$REPO"`; cleanup orphan vite |
| **E5** | Dispatch "succeeded" but log is 0 bytes | Harness reaped background child → foreground Shell (`block_until_ms: 0`, no `&`); post-dispatch sanity check |
| **F1**/**F2** | Merge or mark-done without double-check | Require `.grok-swarm/double-check/<taskId>.md` with `Double-check result: complete` on MAIN; refuse otherwise |
| — | Builder hangs at start, empty log | Missing `--always-approve` → kill, relaunch with it |

---

## End-to-end coordinator loop

```
 1. swarm init <repo> --goal "..." --agents "Coordinator:coordinator,Builder 1:builder,...,Reviewer:reviewer"
 2. Discover this repo (root agent guidance if any; grok inspect); learn gates + default branch
 3. Decompose → swarm task create (disjoint files; --depends for overlaps) → swarm check must pass
    → start the live dashboard: swarm dashboard --open (background; user watches progress in Chrome)
 4. swarm task ready → fill templates/builder-prompt.md per task → dispatch parallel
    `dispatch-grok.sh --mode new` + swarm dispatch record each
    (never raw `grok --worktree` in headless — 1.0.3 `-p` does not create a worktree)
 5. Monitor loop: swarm dispatch list --status running + log tails + mail check --consume + worktree scope check
 6. On worker_done: verify read-only (git status/diff vs owned files; repo gates) → dispatch update --status done
 7. Fix loop via -r <sessionId from dispatch record> (≤3 rounds; then blocked + escalate)
 8. Reviewer pass (--permission-mode plan); REVISE findings → step 7
 9. Merge worktrees sequentially (--no-ff); conflicts delegated to a builder; full gate on merged result
10. Cleanup (grok worktree rm/gc) → swarm goal update --status completed → swarm board --sync → report
```

---

## Dashboard control routes (2026-08-23)

Served by `swarm dashboard` (same port). Every mutation runs `swarm.cjs` as `SWARM_AGENT_NAME=Operator`; responses are `{ok, exitCode, stdout, stderr, steps}`.

| Route | Runs |
| --- | --- |
| `POST /api/control {action:"hold"}` | `swarm pause --no-kill` — builders finish, `dispatch record` refuses new work, coordinator stays alive and keeps verifying/merging |
| `POST /api/control {action:"pause"}` | `swarm pause` + `swarm coordinator stop` (heal skips restart while hard-paused) |
| `POST /api/control {action:"resume"}` | `swarm resume`; `coordinator start --resume --daemon` if dead; `heal --daemon` if dead |
| `POST /api/mail {body}` | `swarm mail send --to Coordinator --type message`; registers `Operator` agent on first use so `@all` reaches the operator |
| `GET /api/mail?swarm=&limit=100` | Operator↔Coordinator transcript + escalations/swarm_complete, `coordinatorAlive`, `paused` |
| `POST /api/task {title, files, acceptance, owner?}` | `swarm task create` (+ `board --sync`); overlap refusals are returned verbatim |

Never wire `pause --all` to a button — it stops the dashboard itself.
