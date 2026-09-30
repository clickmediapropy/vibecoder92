# Failure modes — SKILL.md high-traffic rows not in `reference.md`

Rows already in [`reference.md` § Failure modes](../reference.md#failure-modes) with the same action text are **not** repeated (`hangs` / empty log, **E5** 0-byte dispatch, **F1**/**F2** double-check). **B1** and **A1** are kept here because SKILL.md’s action text is not the same as `reference.md`. Full 30-edge matrix: [`docs/2026-07-15-swarm-edgecases.md`](../docs/2026-07-15-swarm-edgecases.md) + `bin/edge-matrix.cjs`. Filter: `swarm heal doctor --json | jq '.actions[]|select(.edgeId=="A1")'`.

| Symptom | Cause → action |
|---------|----------------|
| `'--single <PROMPT>' cannot be used with '--prompt-file'` | Combined `-p` + `--prompt-file` → `--prompt-file` alone |
| Worktree guard STOP / `TOP==MAIN` (B1) | Raw `grok --worktree` or `--cwd`/`-r` misuse → always `dispatch-grok.sh --mode new` / Mode B `working_directory=$WT_PATH`; no auto-heal |
| `MODEL_SWITCH_INCOMPATIBLE_AGENT` | Wrong `-m` on resume → Mode B fresh, no `-r` |
| Reviewer plan-mode exits after 1 line | Rerun without plan mode + precomputed diff; verify `git status` unchanged |
| Builder edits outside owned files (B2) | Scope drift → `kill`, `dispatch update --status killed`, `grok worktree rm -f`, redelegate tight prompt |
| Worktree not in `grok worktree list` immediately | Poll ≤30s; `grok worktree db rebuild` if DB stale |
| Merge conflict (B3) | Ownership/`depends` violated or shared INDEX → mega union-retry safe paths else `merge_blocked` + builder; single: `git merge --abort` + delegate builder |
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
