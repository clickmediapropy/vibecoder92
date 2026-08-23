# Dashboard control plane: pause/hold/resume + operator↔coordinator chat

Date: 2026-08-23. Status: approved (design). Scope: `catalog/global/skills/grok-swarm/`.

## Contract

From the Mission Control dashboard (`http://127.0.0.1:4599/`) the operator can:

1. **Hold** a swarm (no new dispatches, running builders finish, coordinator alive).
2. **Pause** a swarm (builders tree-killed, coordinator stopped, state preserved).
3. **Resume** from either (coordinator restarted with `--resume`; heal restarted if dead).
4. **Send free-text messages** to the coordinator and **read its replies**.
5. **Add a task** via a small form (title / files / acceptance).

Acceptance: each button/form round-trips through the real `swarm` CLI against a temp workspace in a test, and a live swarm visibly pauses/resumes and answers a chat message.

## Evidence (verified in code)

| Claim | Where |
| --- | --- |
| `swarm pause` tree-kills running dispatches and writes `pause.json`; `--no-kill` leaves builders alive and records `noKill:true` | `bin/swarm.cjs` `pauseOneSwarm` (~L1905–1975) |
| Single-swarm `swarm pause` does **not** stop the coordinator; `pause --all` stops coordinators **and the dashboard + heal** | `pauseCommand` (~L2240), `pauseAllCommand` (~L2080–2115), `stopDashboardAndHeal` |
| `dispatch record` refuses while paused unless `--force` | `bin/swarm.cjs:1593-1595` |
| `swarm resume` archives the manifest and prints Mode C relaunch commands; does not start the coordinator | `resumeCommand` (~L2300–2340) |
| `coordinator start --resume --daemon` exists; no pause check | `coordinatorCommand` L4377+, help L4824 |
| Heal restarts a dead coordinator whenever open tasks exist, with **no pause check** | `bin/heal.cjs:727, 845-880` |
| Coordinator prompt startup step 5 auto-runs `swarm resume` when paused | `templates/coordinator-prompt.md:87` |
| Coordinator polls `mail check --consume` each loop; only `worker_done` semantics documented | `templates/coordinator-prompt.md:114-117` |
| Mail: per-agent inbox + append-only `transcript/<id>.json` copy of every message; `from` = `SWARM_AGENT_NAME`; `MAIL_TYPES = message,status,escalation,worker_done,swarm_complete` | `bin/swarm.cjs:56, 613-651, 97-99` |
| Dashboard server is one `http.createServer` with GET `/api/*` routes; static `/dashboard/*`; HTML from `templates/dashboard.html` | `bin/swarm.cjs:3993-4230` |
| Heal spawns `swarm.cjs` subcommands with an overridden `SWARM_AGENT_NAME` env — reusable pattern | `bin/heal.cjs:870-878` |
| `/api/state` already carries `paused` (manifest); structure-key changes on pause | `swarm.cjs:455,3054`; `dashboard/js/structure-key.js:53` |
| `swarm task create --title --owner --files a,b --acceptance --depends --force` | `swarm.cjs:4761` |

## Design

### 1. Server routes (`bin/swarm.cjs`, dashboard handler)

All new routes resolve the target swarm from `?swarm=` / body `swarm` (default: the single/current swarm). POSTs read a JSON body (cap 64 KB), spawn `process.execPath swarm.cjs …` with `env.SWARM_AGENT_NAME='Operator'`, `SWARM_ID=<swarm>`, cwd = repo, timeout 60 s, and return `{ok, exitCode, stdout, stderr}`.

| Route | Runs |
| --- | --- |
| `POST /api/control {action:"hold"}` | `pause --no-kill --reason "operator hold"` |
| `POST /api/control {action:"pause"}` | `pause --reason "operator pause"` then `coordinator stop --swarm <id>` |
| `POST /api/control {action:"resume"}` | `resume`, then `coordinator start --resume --daemon --swarm <id>` if no live coordinator, then `heal --daemon` if `heal/healer.pid` dead |
| `POST /api/mail {body}` | `mail send --to Coordinator --type message --body …` |
| `GET /api/mail?swarm=&limit=` | reads `transcript/*.json`, keeps `from/to ∈ {Operator, Coordinator}` or `type ∈ {escalation, swarm_complete}`, sorted by timestamp, last `limit` (default 100). Also returns `coordinatorAlive` (pidfile check). |
| `POST /api/task {title, files, acceptance, owner?}` | `task create --title … --files … --acceptance …` (no `--force`; overlap errors surface verbatim) |

Register `Operator` in `agents.json` on first use if absent (`agent register`), so `@all` broadcasts reach the operator inbox.

### 2. Heal guard (`bin/heal.cjs`)

Before A2 coordinator restart: read `pause.json`; if present and `!noKill` → log `coordinator-paused-skip`, continue. Hold (`noKill`) leaves restart behavior unchanged (coordinator is meant to stay alive).

### 3. Coordinator prompt (`templates/coordinator-prompt.md`)

- Startup step 5 → "If `pause.json` exists: `noKill:false` → `swarm resume` and relaunch; `noKill:true` → **HOLD**: do not resume, keep reconcile/verify/merge, dispatch nothing until the manifest is gone."
- Main loop: re-check hold every poll (`swarm state --json` → `paused.noKill`).
- New section **"Operator mail"**: messages with `from: Operator` are instructions from the human owner. Act (steer, re-prioritize, cancel/add tasks via `swarm task create`, answer questions); reply with `swarm mail send --to Operator --type message --body "…"` in the same loop; never leave an operator message unanswered; never treat it as noise. Escalations already go `--to @all`, which now includes Operator.

### 4. UI (`templates/dashboard.html`, `dashboard/js/ui.js`, `css`)

- Topbar: `Hold` / `Pause` / `Resume` buttons. Enabled state derived from `state.paused` (`null` → Hold+Pause; `noKill:true` → Pause+Resume; else Resume only). Click → POST, then force a hard refresh of state. Failures render stdout/stderr in the existing condition-banner area.
- Chat panel ("Coordinator") under the board: message list from `/api/mail` (polled on the existing tick, own endpoint so no structure-key change), textarea + Send, "Add task" disclosure with title / files / acceptance → `/api/task`. Header shows `coordinator: live | stopped | paused`. When stopped and not paused, Send still delivers (mail persists) and the panel says "coordinator offline — message queued; Resume to deliver".

### 5. Docs

`SKILL.md` dashboard row + autonomous table: pause/resume/chat now available from the dashboard; `/grok-swarm pause|resume` remain CLI equivalents. `reference.md` gets the route table.

### 6. Tests

- `bin/dashboard-control.test.mjs`: start the server in-process against a temp repo + workspace; assert hold → `pause.json.noKill===true` and `dispatch record` refuses; pause → coordinator pidfile gone; resume → manifest archived; `/api/mail` POST creates inbox + transcript entries with `from:"Operator"`; GET returns them; `/api/task` creates a task and surfaces overlap refusal.
- `bin/heal.test.mjs`: paused (`noKill:false`) swarm with dead coordinator → no restart; hold → restart still allowed.
- Live verification (rule 1): run a real swarm, click through Hold/Pause/Resume, send a message, confirm coordinator reply in panel.

## Out of scope / rejected

- Separate control daemon (B): 4th process to heal/stop; no benefit.
- Chat-only pause (C): pause must be mechanical, not LLM-interpreted.
- Auth on POST routes: server binds 127.0.0.1 and is exposed only via Tailscale serve, same trust boundary as today's read routes.
- Multi-swarm "pause all" button: `pause --all` kills the dashboard itself; per-swarm only.
