# Grok-swarm fast quality bar

## Keep (non-negotiable)
- Scoped typecheck / lint / ui:policy (repo scripts)
- `/double-check` complete on builders
- Product REVISE (high) → rebuild, never force-pass
- Disjoint file leases + same `--worktree-ref`

## Speed levers (quality-safe)
1. **Micro-packs (~20):** 1 dir → 1 team when budget allows; 1 builder; scout only on `full`
2. `builders≤30` / `coordinators≤16` are ceilings — watch **ready** work, not free slots
3. Kill orphan Vite on pack cleanup (`swarm cleanup` / `mega cleanup`)
4. Visual tiers: full / smoke / gates_only
5. Auth BLOCKED + green gates → force-pass (healer or mega visual pass)
6. Shared packs: thin depends_on (features, not every component pack)
7. Prefer one FE mega per host; second mega only if leases disjoint and RAM allows
8. Integrate-branch visual once for gates_only packs
9. `swarm mega propose --packs 20 --builders 1`

## Forbidden
- Skip typecheck to "go faster"
- Force-pass product REVISE
- Parallel builders on overlapping files
- Leaving 10+ Vite processes after packs merge
