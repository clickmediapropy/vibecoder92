# Sizing, host hygiene, worktree seed, cleanup

Capacity numbers already in [`reference.md` § mega](../reference.md) and [`templates/host-capacity.default.json`](../templates/host-capacity.default.json). This file keeps SKILL.md text that was **not** already there.

**Sizing (mega):** host ceilings from [`templates/host-capacity.default.json`](../templates/host-capacity.default.json) / `bin/capacity.cjs` — **16** coordinators / **30** builders / **15** reviewers / **10** scouts / **6** loggers / **8** visual / **10** dev servers. These are host-owned ceilings via `swarm capacity set` / `.grok-swarm/host-capacity.json` (see `swarm capacity show`), not a hard “4 coordinators” law. See `docs/2026-07-14-mega-swarm-design.md`. Parallel megas share free slots; `mega check`/`launch` refuse lease clashes unless `--force`.

Micro-pack default (`swarm mega propose`): ~20 packs, 1 builder per single-dir pack, scout only on `visual_tier: full`, host ceilings as above. Quality bar: gates + double-check + visual findings (`docs/2026-07-15-fast-quality-bar.md`). Visual tiers `full`/`smoke`/`gates_only`; auth BLOCKED → `swarm mega visual pass` / `swarm heal --auto-visual-pass` (never force product REVISE).

Host hygiene: cleanup kills worktree Vite; `swarm capacity show` warns if `> max_dev_servers`; prefer one FE mega per host. 1.0.0 sandbox fix: `GROK_SWARM_SANDBOX=workspace` no longer hangs on large deny-glob trees. Dashboard: localhost, 2–5s poll, RAM display, auto `pause --all` < `min_free_ram_gb`.

Worktree env seed: `dispatch-grok.sh --mode new` copies `worktree-seed.json` paths (`.env.local`/secrets) MAIN → worktree; seeded files are gitignored and removed when the worktree is cleaned (`grok worktree rm` + `host-capacity`/mega cleanup). Never commit them.

Cleanup (mandatory, automated): `swarm goal update --status completed` auto-runs `swarm cleanup --swarm <id>` (worktrees + `swarm/wt-*` branches + archive; seeded env deleted with worktree). Soft-fails `grok worktree gc --max-age 7d` warns when `GROK_SWARM_WORKTREE_GC=1` (set `0` to skip). Heal fallback cleans stale `wt-*` if goal already completed; mega meta runs `swarm mega cleanup --full`; logger after **every** merge → `docs/solutions/` or `.grok-swarm/learnings/`. Disk: `grok du --json` lists `~/.grok` (sessions + worktrees) before a sweep.

Auto-cleanup after `goal completed` now deletes both `~/.grok/worktrees` *and* `swarm/wt-*` branches (heal fallback counts branches too); dashboard/heal daemons are stopped via `swarm coordinator stop && swarm dashboard stop && swarm heal stop` or `swarm pause --all` (which scavenges and checks residual).

Mega integrate: `swarm mega run --auto-merge` skips already-integrated branches, union-resolves only `INDEX`/`learnings`/`SUMMARY` via `merge-file --union`, else `merge_blocked` + builder prompt under `.grok-swarm/mega/<id>/`. After merges: full repo gates, then `grok worktree rm` + `task update --status done` + `goal update --status completed` + `board --sync`. Seeded `.env` files disappear with worktrees.
