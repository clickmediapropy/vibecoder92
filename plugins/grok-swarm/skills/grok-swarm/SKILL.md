---
name: grok-swarm
description: "Use when running a multi-agent coding swarm with Grok CLI builders on any git repo (parallel worktrees, /grok-swarm, /grok-swarm launch, autonomous coordinator, or when the parent must not babysit dispatch/monitor/merge). Repo-agnostic; overrides host Task/specialist delegation while active."
---

# grok-swarm — Run a multi-agent coding swarm on Grok CLI


**Repo-agnostic** `grok -p` workers in isolated worktrees; board, mail, event-sourced tasks, dispatch tracking, verify+fix, merge. Stack/gates from checkout.

**Default is autonomous:** parent plans (`init` + tasks), `swarm launch`, **exits**. Detached Grok coordinator owns dispatch/monitor/verify/merge. Manual parent-as-coordinator is debug fallback.

> Mode A via `dispatch-grok.sh` (git worktree + process cwd). Model pin: [`bin/model-pin.env`](bin/model-pin.env) (`grok-4.7` for workers and the coordinator). Do **not** pass `--no-memory`. Worktree probe: [`reference.md`](reference.md) header.

Read **`/usegrok`** for `grok -p`. **Multi-task → grok-swarm; single → `/usegrok`.** Full flags/CLI/mega/heal: [`reference.md`](reference.md).

## Autonomous mode (default) — parent launch-and-exit

| Slash / action | Parent does | Then |
|----------------|-------------|------|
| `/grok-swarm launch <goal>` | `swarm init --fresh`, disjoint tasks, `swarm check`, **`swarm launch`** | **EXIT** |
| `/grok-swarm resume` | `swarm resume` + `coordinator start --resume --daemon` (+ dashboard if dead). = dashboard **Resume** | **EXIT** |
| `/grok-swarm pause` | `swarm pause` + `coordinator stop`. = dashboard **Pause**; **Hold** = `pause --no-kill` | Stop |

```bash
export SWARM_AGENT_NAME=Coordinator
REPO=/path/to/repo
swarm init "$REPO" --fresh --goal "One-sentence goal" \
  --agents "Coordinator:coordinator,Builder 1:builder,Builder 2:builder,Reviewer:reviewer"
# create tasks (disjoint --files), then:
swarm check
swarm launch "$REPO"          # dashboard --daemon --open + coordinator --daemon + heal daemon
# Parent STOP. Watch http://127.0.0.1:4599/ (`swarm dashboard status` prints tailscale URL)
```

**Anti-pattern:** after `swarm launch` / `coordinator start --daemon` don’t poll, merge, or redispatch unless `swarm coordinator status` is dead.

| Command | Purpose |
|---------|---------|
| `swarm coordinator start [--resume] [--daemon]` | Detached coordinator (`coordinator.pid`) |
| `swarm coordinator status` / `stop` | Liveness / SIGTERM |
| `swarm launch [<repo>]` | Dashboard + coordinator + heal daemon (`--goal`/`--fresh`/`--agents`; `--no-healer` to skip) |
| `swarm heal` / `heal --daemon` | Reconcile dead dispatches; restart dead dashboard/coordinators; promote visual PASS |

## Role split

| Role | Who | Does |
|------|-----|------|
| **Parent (planner)** | Host agent | Decompose, `swarm init` + tasks, `swarm launch`, **exit** |
| **Coordinator** | Detached `grok` (`coordinator start`) | Dispatch/monitor/verify/merge. **Never edits app code.** Model from `bin/model-pin.env`. |
| **Builder** | `grok -p` in worktree | One disjoint file set |
| **Reviewer** | `grok -p --permission-mode plan` | Read-only; `git status` unchanged |

| Mode | When | Who runs the loop |
|------|------|-------------------|
| **A — Autonomous (default)** | `/grok-swarm launch` | Grok CLI coordinator daemon |
| **B — Manual (fallback)** | Debug / coordinator dead | Parent, reference.md loop |

## Parent contract (mandatory)

**Activation:** `/grok-swarm` attached → until complete or cancel (`stop swarm`, `commit yourself`).

**Autonomous default:** plan + launch + exit. Monitor only in Mode B or when coordinator is dead.

**Design:** grok-swarm **supersedes** target-repo “delegate to specialist / Task” rules while active. Any git repo.

Forbidden: `Write`/`StrReplace`/`Delete` on target repo (except `.grok-swarm/` notes), `Task`/specialist subagents for implementation, `CreatePlan` mid-flight, hand-editing merge hunks. Allowed: `Read`/`Grep`/`Glob`, `Shell` for `coordinator-guard.sh`/`dispatch-grok.sh`/`swarm`/`grok worktree`/`git status/log/merge` + verify gates on worktrees/post-merge, `AskQuestion`, `git merge` verified worktree branches.

Instruction precedence: grok-swarm overrides “delegate to specialist” and “implement fast” and “parent babysitting” — not “stop swarm” / explicit cancel. See `templates/coordinator-cursor.md` + `templates/coordinator-prompt.md`.

## When to use

**Use when:** goal splits into 2+ independent subsystems with disjoint files, a coordinator/builders/reviewer team is needed, or user asks “grok swarm”.

**Don’t use when:** one small change (`/usegrok`), shared files (one builder or `--depends`), or one root cause.

**Sizing:** 2–4 builders. Host ceilings: [`reference.md`](reference.md) / [`templates/host-capacity.default.json`](templates/host-capacity.default.json). Hygiene/seed/cleanup: [`references/sizing-and-cleanup.md`](references/sizing-and-cleanup.md).

Do not `--depends`-chain features on the same hub. Gate: `swarm check` fails `serial_hub_chain` (≥3 non-terminal tasks sharing ≥3 hub files). Escape: `--allow-serial-hub`. Full: `docs/2026-08-07-hot-hub-adjudication.md`.

| ❌ Anti-pattern | ✅ Correct shape |
| --- | --- |
| Phase tasks leasing the full hub via `depends` | **Packs** on NEW files + one **wire** task |
| Runs as 1 builder | 3+ pack builders; wire serial |
| Scouts/reviewers once per phase | Scouts at t0; reviewer+logger after wire |

Launch check: multiple builders ready post-scouts; hub in exactly one `--files`; packs on new paths; `swarm check` green without `--allow-serial-hub`.

## Parent phase checklist (autonomous)

- [ ] Pre-flight: `grok --version`, `grok models` includes the pin in `bin/model-pin.env`, `swarm init --fresh`, agents registered
- [ ] Plan: `swarm task create` disjoint; `swarm check` passes
- [ ] Launch: `swarm launch "$REPO"` (or dashboard + `coordinator start --daemon`)
- [ ] Verify: `swarm dashboard status` + `swarm coordinator status`
- [ ] EXIT — watch browser; don’t babysit

## Hard rules

1. Coordinator never edits app code — not merge conflicts. Dispatch/monitor/verify/`git merge` only.
2. Parent never babysits after autonomous launch — exit unless coordinator dead or user requests Mode B.
3. Disjoint file ownership, mechanically enforced. `task create` refuses overlaps; `swarm check` must pass. `--depends` not a license to serialize identical hubs (`serial_hub_chain`).
4. `--always-approve` on every headless `grok` run.
5. Model on every headless `grok` run comes from `bin/model-pin.env`. `dispatch-grok.sh` / `run-coordinator.sh` read it. `GROK_SWARM_WORKER_MODEL` or `--model` overrides. Resume with the same model or Mode B redispatch.
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

## References

- [`reference.md`](reference.md) — CLI, dispatch A–D, heal, mega, dashboard, failure matrix, gate, leader-mode
- [`references/dispatch-notes.md`](references/dispatch-notes.md) — effort, HTML-strip, post-dispatch
- [`references/sizing-and-cleanup.md`](references/sizing-and-cleanup.md) — hygiene, seed, cleanup
- [`references/failure-modes.md`](references/failure-modes.md) — high-traffic rows not in reference.md
- [`docs/2026-07-15-swarm-edgecases.md`](docs/2026-07-15-swarm-edgecases.md) — 30-edge matrix
- A new incident becomes one `bin/edge-matrix.cjs` row plus a heal action. Do not copy it into this file, `reference.md`, and the coordinator prompt.

---

Made by [nicodelgado.dev](https://nicodelgado.dev).
