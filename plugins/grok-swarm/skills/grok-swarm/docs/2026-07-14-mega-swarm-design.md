# Mega-Swarm Design — 5× scale on a single VPS

**Status:** approved (2026-07-14)
**Skill:** `grok-swarm` (`~/.grok/skills/grok-swarm/`)
**Environment:** single machine (VPS, ~48 GB RAM); not multi-host fleet

## Problem

Today’s grok-swarm sweet spot is **2–4 builders** and **one** Grok coordinator. Beyond ~5 agents, coordination overhead (LLM poll loop, serial verify/merge, no capacity governor, no cross-swarm leases) dominates. Large goals (“refactor all frontend”) do not fit one swarm cleanly.

## Goals

| Metric | Today (approx) | Target |
|--------|----------------|--------|
| Concurrent builders | 2–4 | **up to host max (default 30)** |
| Concurrent coordinators | 1 | **up to host max (default 10)** — shared across parallel megas |
| Tasks per mission | ~4–8 | **20–40** across sub-swarms |
| Parent after launch | Often babysits | **Plan → launch → exit** |
| Merge safety | Intra-swarm check only | **Leases + integrate branch + final gates** |
| Visual quality | Code-only optional reviewer | **agent-browser visual QA → redispatch builders** |
| Worktree usability | No env seed | **Copy credentials from MAIN** |
| Post-mission | Orphan worktrees common | **Mandatory full teardown; field clean** |

## Non-goals (v1)

- Multi-machine fleet
- Replacing sub-swarm LLM coordinators with a single mega LLM
- Parent implementing product code
- Parallel writes to the same files across sub-swarms
- Merging each sub-swarm straight to `main`/`master`

## Architecture

```
Parent (meta-orchestrator)
  plan partition + size + write plan.json
  swarm mega check / launch
  EXIT
        │
        ▼
  mega control plane (deterministic Node)
  capacity · leases · queue · health · ordered integrate merge · cleanup
        │
   ┌────┼────┬────────────┐
   ▼    ▼    ▼            ▼
 Sub-swarm A  B  C …   each: Grok coordinator + builders (+ visual reviewer)
   worktrees seeded from MAIN
   merge target: swarm/sub/<mega>/<name>  →  swarm/integrate/<mega-id>
        │
        ▼ full gates
   default branch (main/master)
        │
        ▼
   mega cleanup --full → doctor --expect-clean
```

### Roles

| Role | Who | Job |
|------|-----|-----|
| **Parent** | Cursor / Claude / interactive Grok | Partition goal, emit plan, launch, exit. Mode B unstick only. |
| **Meta daemon** | `swarm mega run --daemon` (Node) | Capacity, leases, start/stop sub-swarms, integrate merges, cleanup. **Not** an implementer. |
| **Sub-swarm coordinator** | Grok CLI (as today) | Dispatch/monitor/verify/fix/merge **within** lease; merge to sub/integrate branch, never main. |
| **Builder** | Grok in worktree | Implement owned files only. |
| **Visual reviewer** | Grok + **agent-browser** | No product code edits; screenshots + findings; REVISE → assign builders. |
| **Code reviewer** | Optional read-only | Static audit; secondary to visual for UI work. |

## Capacity (host-shared; not a hard “4 coordinators” law)

The old **4 / 12 / 2** numbers were a soft VPS heuristic, **not** a Grok limit. Defaults are now high; you raise or lower via `.grok-swarm/host-capacity.json` (`swarm capacity set`).

| Knob | Default (host) |
|------|----------------|
| `max_coordinators` | **16** (micro-pack; was 10) |
| `max_builders` | **30** |
| `max_reviewers` | **15** |
| `max_scouts` | **10** |
| `max_loggers` | **6** |
| `max_visual_reviewers` | **8** |
| `max_dev_servers` | **10** (micro-pack; was 6) |
| `ram_reserve_gb` | 4 |

**Parallel megas:** free slots = host max − live usage across **all** active megas. Lease check refuses overlapping files with peer megas.

**Five roles:** coordinator · scout · builder · reviewer · **logger** (after merge: write learnings to `docs/solutions/` when present, else `.grok-swarm/learnings/` — symptom, root cause, fix, prevention; update INDEX; optional rule under `.grok/rules/`).

Governor queues sub-swarms/tasks when caps would be exceeded.

## Merge policy

1. Builders → worktree branches `swarm/wt-*`
2. Verified + visual PASS → merge into `swarm/sub/<mega-id>/<name>`
3. Meta merges sub-branches into `swarm/integrate/<mega-id>` in **dependency order**
4. Full repo gates on integrate
5. Merge integrate → default branch
6. **Full teardown** (see below)

## File leases

Cross-sub-swarm ownership is **hard**:

- Resolved paths (globs expanded) claimed in `leases.json` when a sub-swarm starts
- Intersecting active leases refused unless `depends_on` is satisfied and prior sub-swarm is `done`
- Shared roots (`package.json`, design tokens, locales) → final sequenced sub-swarm

## Worktree env seed

After `git worktree add` (Mode A), **before** `grok` starts:

1. Read seed manifest (repo `.grok-swarm/worktree-seed.json` or mega plan `worktree_seed`, else skill defaults)
2. Copy from MAIN → worktree (e.g. `.env.local`, `.env`, `playwright/.auth/user.json`)
3. Log path names only (never secret values)
4. Optional `required` list fails dispatch if missing on MAIN
5. Mode B/C: re-seed if file missing in worktree but present on MAIN
6. Seeded files must never be committed

## Visual review (agent-browser)

For UI-facing sub-swarms (`visual_review: true`, default when owned paths look frontend):

1. Env-seeded worktree or sub-branch preview
2. Reviewer uses **agent-browser** (navigate, snapshot, screenshot)
3. Writes `review_result.json` + artifacts under mega/swarm review dir
4. `PASS` → allow merge; `REVISE` → tasks/mail to builders with route + screenshot + owned files
5. Coordinator redispatches builders (bounded fix loop), re-runs visual
6. Optional mega visual pass on integrate before main
7. Capacity-gated (`max_visual_reviewers`, `max_dev_servers`); prefer `vite preview` when possible

Reviewer must **not** edit application source (`--disallowed-tools` write tools). Artifacts-only writes allowed.

## Teardown (mandatory)

Mission not complete until cleanup + doctor clean.

| Artifact | On success |
|----------|------------|
| Worktrees `wt-*` for mega | Remove |
| Branches `swarm/wt-*`, `swarm/sub/*` | Delete after merged |
| `swarm/integrate/<id>` | Delete after merged to main |
| Seeded env copies | Gone with worktree |
| Builder/reviewer/coordinator PIDs | SIGTERM → SIGKILL |
| Dev/preview servers | Kill by recorded PID/port |
| Live swarm workspaces | Archive to `.grok-swarm/archive-*` |
| Mega plan/leases | Archive under `.grok-swarm/mega/archive/` |
| Logs /tmp | Archive then remove |
| Grok sessions | Best-effort delete swarm-tagged only |

**Never remove:** MAIN checkout, MAIN `.env.local`, unrelated worktrees/swarms.

Commands:

```bash
swarm cleanup --swarm <id>           # sub-swarm worktrees + PIDs
swarm mega cleanup --id <id> --full  # entire mission
swarm mega doctor --expect-clean     # pre-flight for next mega
```

`mega launch` runs doctor (or `--force` with warning). Pause ≠ teardown.

## Plan schema (summary)

See `templates/mega-plan.schema.json`. Core fields: `id`, `goal`, `base_ref`, `integrate_branch`, `default_branch`, `capacity`, `worktree_seed`, `subswarms[]` with `name`, `files`, `builders`, `depends_on`, `visual_review`, `acceptance`.

## Parent contract

1. Discover repo (gates, default branch, layout)
2. Partition into disjoint domains (features first, shared last)
3. Emit `plan.json`
4. `swarm mega check`
5. `swarm mega launch`
6. **EXIT** — watch meta status/dashboard

## Phasing

| Phase | Deliverable |
|-------|-------------|
| **P1** | Design doc; worktree seed; mega plan/check/launch/status/cleanup/doctor; leases; capacity; visual templates; tests. **Shipped.** |
| **P2** | Meta daemon (`mega run --daemon` / tick), integrate merge (`mega merge`), hard visual gate on `mark done`, dashboard `/api/mega` panel. **Shipped 2026-07-15.** |
| **P3** | `mega propose` partition heuristics + `mega-planner-prompt.md`. **Shipped.** |
| **P4** | Floor mode (`"floor": true` — no Grok coordinator; meta tick dispatches builders). **Shipped (minimal).** |
| **P5** | Fast-quality: visual-policy module, visual_tier, orphan vite cleanup, thin shared depends_on, heal eligibility. **This plan.** |

## Implementation map (P1)

| Path | Change |
|------|--------|
| `bin/dispatch-grok.sh` | Seed env after worktree create |
| `bin/swarm.cjs` | `mega *`, `cleanup`, lease helpers |
| `templates/mega-plan.schema.json` | Schema |
| `templates/worktree-seed.default.json` | Default seed list |
| `templates/visual-reviewer-prompt.md` | agent-browser reviewer |
| `templates/coordinator-prompt.md` | Integrate merge target; visual gate; cleanup |
| `templates/builder-prompt.md` | Visual fix redispatch notes |
| `SKILL.md` / `reference.md` | Mega sizing + contracts |
| `bin/*.test.mjs` | Seed + mega check/cleanup tests |

## Success criteria

- “Refactor all frontend”-class goals expressible as one mega plan with 6–10 sub-swarms
- 3–4 concurrent sub-swarms without OOM roulette (caps)
- Builders get working env in worktrees
- Visual REVISE loops assign builders
- Integrate → main once; then **doctor clean** for the next mission
