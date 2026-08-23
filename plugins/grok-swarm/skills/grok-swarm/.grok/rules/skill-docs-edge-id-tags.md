# Rule: SKILL/reference tag edge IDs — never paste full matrix

**When it applies:** Editing `SKILL.md` / `reference.md` Failure modes, heal CLI docs, or any always-on skill surface that mentions recovery, heal doctor, or capacity.

## Bad pattern

- Paste the full A1–F3 (30-row) edge table into SKILL or reference.
- Describe stall / MAIN dirty / auth BLOCKED / force-pass without edge IDs (A1, B1, C2, F1…).
- Document a heal `edges[]` aggregation that does not exist; invent recovery prose that contradicts `isAutoSafe` (C4/B1/F1 never auto).
- Re-edit `docs/2026-07-15-swarm-edgecases.md` or `bin/heal.cjs` from a docs-only lease.

## Good pattern

- Point to `docs/2026-07-15-swarm-edgecases.md` + `bin/edge-matrix.cjs`.
- Tag high-traffic symptoms with `(edge ID)`; compact pointer table for the rest.
- Teach detect one-liners: `heal doctor … edgeId=="A1"`, `capacity show`, MAIN/wt `rev-parse` for B1.
- Heal operator contract: `actions[].edgeId` on doctor JSON.

## Verify

```bash
rg -n 'swarm-edgecases|edge-matrix|edgeId' SKILL.md reference.md
# Full matrix must NOT be inlined as 30 symptom rows in SKILL
test -f docs/2026-07-15-swarm-edgecases.md
```

## Related learning

`.grok-swarm/learnings/2026-07-15-skill-reference-edge-links.md`
