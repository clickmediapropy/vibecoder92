<!--
Optional Grok planner prompt: suggest a mega plan.json for a large goal.
Parent may also use: swarm mega propose --repo … (deterministic partition).
-->

You are planning a **grok-swarm mega mission**. Output **only** valid JSON matching templates/mega-plan.schema.json (no markdown fence).

## Repo
`{{REPO_PATH}}`

## Goal
{{GOAL}}

## Rules — micro-pack teams (default)
1. Partition into **~12–20 subswarms** (target **20** when the tree allows) with **disjoint** `files` globs (no overlap unless `depends_on` sequences them). Prefer **1 directory per pack**; only multi-dir pack when over coordinator budget.
2. Prefer vertical slices (features/domains) first; put shared UI / tokens / locales **last** with thin `depends_on` (feature consumers only — see below).
3. Each micro-pack role budget:
   - `builders`: **1** (2 only if multi-dir pack)
   - `scouts`: **1** only when `visual_tier` is `full`; else **0**
   - `loggers`: **0** during build (batch logger after integrate)
   - coordinator + builder (+ visual reviewer when tier needs it)
4. Optional `"floor": true` for tiny non-UI cleanup slices (meta dispatches without a Grok coordinator).
5. Capacity (host-shared): max_coordinators **16**, max_builders **30**, max_reviewers **12**, max_scouts **8**, max_loggers **4**, max_visual_reviewers **8**, max_dev_servers **10**. Raise via `swarm capacity set` / host-capacity.json.
6. Parallel megas: file leases must not overlap other *active* megas (e.g. FE `src/**` vs BE `convex/**` is fine). Prefer **one FE mega per host**.
7. `id` slug: lowercase letters, digits, hyphens, max 48 chars.
8. `integrate_branch`: `swarm/integrate/<id>`.

## Visual tiers (assign every subswarm)
- **full**: mobile, inbox, auth, marketing landing, app shell — agent-browser all owned routes (+ scout 1)
- **smoke**: most component packs (2–4 owned routes, scout 0)
- **gates_only**: pure lib/tokens with no route surface — code gates + double-check only; visual once on integrate
- `visual_review: false` when `visual_tier` is `gates_only`; true for `full` / `smoke`

## depends_on for shared ui/common
- Depend on **feature packs that consume shared UI**, not every `components-*` pack.
- Prefer **≤4** `depends_on` unless a true lease requires more.
- Never block shared ui on mobile packs that do not import it.
- Never set `depends_on` to the full parallel pack list when N > 4.

Discover tree with list_dir/grep if needed, then emit the plan object.
