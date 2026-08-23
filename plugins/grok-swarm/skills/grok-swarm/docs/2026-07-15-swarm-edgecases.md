# Swarm edge-case operator matrix

Canonical catalog: `bin/edge-matrix.cjs` (`EDGES`, `isAutoSafe`, `listEdges`, `byArea`).
Plan: `docs/plans/2026-07-15-grok-swarm-edgecase-mitigation.md`.

**auto** = mechanical heal/mega may act when `autoSafe` and policy gates allow.
**Never** auto-PASS product REVISE with high findings; never skip typecheck/lint/ui:policy/DC when a pack claims green.
Force-pass only: auth/harness BLOCKED (or aged non-product BLOCKED) **and** gates+DC green.

| ID | detect command | auto | manual Mode B |
|----|----------------|------|---------------|
| A1 | `swarm heal doctor --json` / coord log mtime frozen >3m while tasks in review | yes — `coordinator-stall-restart` (rate-limit 1/10m) | `swarm coordinator stop && start --resume --daemon`; verify merges |
| A2 | `swarm coordinator status` dead; `coordinator.pid` stale | yes — restart dead coord (`max-turns-or-exit`) | same restart; check `coordinator.log` for max-turns |
| A3 | `swarm dashboard status`; port 4599 busy | yes — dashboard restart / alternate port | `dashboard stop`; `dashboard --daemon --open --port <n>` |
| A4 | mega queue frozen; meta daemon dead | yes — mega meta restart | `swarm mega run --id <id> --daemon --auto-merge` |
| A5 | `swarm dispatch list --json` duplicate running same task+pid | yes — dedupe on record | `dispatch reconcile`; drop ghost rows |
| A6 | force-pass eval blocked with empty open tasks | yes — eval DC+review_result without hasOpen | `heal --auto-visual-pass` after gates+DC green |
| B1 | `git rev-parse --show-toplevel` TOP==MAIN + dirty product | **no** | STOP; audit MAIN; redispatch Mode B into worktree; never merge |
| B2 | `git -C $WT diff --name-only` vs owned files | **no** (note only v1) | kill builder; redispatch tighter scope |
| B3 | `git merge` conflict on integrate | **yes** — `merge-file --union` on INDEX/learnings; else `merge_blocked` + builder dispatch; meta daemon stays alive | `swarm mega merge --id <id> --json`; resolve via builder prompt in `.grok-swarm/mega/<id>/merge-conflict-resolve.md` |
| B4 | dispatch worktree create fails name collision | yes — cleanup stale name | `grok worktree list`; `rm <id> -f`; retry |
| B5 | `swarm mega doctor` soft dirty after done | yes — doctor leftovers list + fix one-liner | `mega cleanup --full`; kill orphan vite |
| C1 | visual Cargando / Convex WS 1006 | yes — proxy-unset path | unset `http_proxy`/`https_proxy`/`ALL_PROXY` for vite + browser |
| C2 | login OK, `/app/*` always redirects | yes — auth force-pass when policy ok | re-auth on **same** origin as `APP_BASE_URL`; or `mega visual pass` |
| C3 | visual BLOCKED missing TEST_EMAIL | yes — seed hint | seed `.env.local` into wt; redispatch visual |
| C4 | `review_result` REVISE ×3 high product | **no** | max 3 fix loops then blocked+escalate; never force-pass |
| C5 | visual PID dead, no `review_result`, age >12m | yes — age force-pass if gates+DC | `heal --auto-visual-pass` or redispatch visual once |
| C6 | soft/inferred green gates before force-pass | **no** | require hard gate evidence; refuse inventing gates |
| D1 | `swarm check` fails on cancelled + bad depends_on | yes — scrub dependsOn to `[]` | edit task deps or cancel cleanly |
| D2 | board shows ghost tickets from old swarm | yes — archive/scrub | `swarm init --fresh` before new mission |
| D3 | `swarm check` cycle; `task ready` empty forever | **no** | break depends_on cycle in plan |
| D3b | `swarm check` `serial_hub_chain` — board looks parallel, only 1 builder ready | **no** (by design) | replan packs + one wire hub; see `docs/2026-08-07-hot-hub-adjudication.md`; escape `--allow-serial-hub` only for in-flight legacy |
| D4 | peer mega lease clash mid-flight | yes — pause offending sub | stop one mega; `mega check` leases |
| D5 | gates_only pack running visual | yes — skip visual dispatch | mark visual skipped; rely on integrate visual |
| E1 | packs queued with free builders but no coord slots | yes — status `queued_reason: capacity` | wait or raise host capacity; not a hang |
| E2 | `swarm capacity show` live vite ≫ max | **no** (warn / refuse unless --force) | cleanup orphan vite; `--force` only if intentional |
| E3 | two FE megas active same host | **no** (hard problem unless --force) | run FE megas sequentially or disjoint hosts |
| E4 | capacity count includes foreign project vite | yes — basename filter default | pass repo basename; ignore foreign PIDs |
| E5 | builder log 0 bytes >90s, pid alive | yes — log-stall note (no kill v1) | redispatch Mode B; check harness reaping |
| F1 | merge/force-pass without DC complete | **no** | require `.grok-swarm/double-check/<taskId>.md` with `Double-check result: complete` |
| F2 | missing double-check file on MAIN | **no** | refuse mark done; copy DC report to MAIN path |
| F3 | main tests fail; `pip show` → worktree path | **no** (stack-specific) | reinstall editable on MAIN; `PYTHONPATH=$WT/src` for wt gates |
| F4 | `vp fmt`/`vp staged`/vite.config import **SIGBUS** (exit 135); oxfmt direct still works | **yes** if repo has `npm run verify:native:fix` | truncated optional native (often `lightningcss-*.node` with `missing section headers`); hardlinked across worktrees. Detect: `npm run verify:native` or `file node_modules/lightningcss-linux-x64-gnu/*.node`. Fix: `npm run verify:native:fix` or reinstall package from registry — never copy `.node` between worktrees. |

## Quick detect recipes

```bash
# Lifecycle stall
swarm heal doctor --repo "$REPO" --json | jq '.actions[]?|select(.type|test("stall"; "i"))'

# Capacity / vite
swarm capacity show --repo "$REPO"

# MAIN dirty (B1)
git -C "$REPO" status --short
test "$(git -C "$WT" rev-parse --show-toplevel)" != "$(git -C "$REPO" rev-parse --show-toplevel)"

# Catalog from Node
node -e "const m=require('./bin/edge-matrix.cjs'); console.log(m.listEdges().length, m.isAutoSafe('C4'))"
```

## Related

- Already mitigated (still cataloged): dead-PID reconcile, auth visual force-pass policy, orphan Vite, Mode A isolation, lease check at plan time.
- Heal wiring: Tasks 2+ of the edge-case mitigation plan.
- Double-check protocol: `templates/double-check-protocol.md`.
