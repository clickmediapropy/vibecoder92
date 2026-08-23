# Hot-hub adjudication (packs + wire)

**Date:** 2026-08-07  
**Incident:** Omni CRM tools expansion swarm (`omni-phases-2-6`) looked like a multi-agent swarm but ran as **one builder at a time**.  
**Cause:** Five “phase” tasks each leased the **same** shared Omni hub files (`tools.ts`, `toolSchemas.ts`, `mutations.ts`, dual read paths, locales, approval card) and chained them with `--depends`. File-lease law correctly serialized them → coordinator idle, dashboard shows 1 builder.

## The anti-pattern

```
Phase2 --files HUB --depends none
Phase3 --files HUB --depends Phase2
Phase4 --files HUB --depends Phase3
…
```

`swarm task create` allows this because `--depends` sequences the overlap.  
`swarm check` historically only rejected *unsequenced* overlaps.  
Result: **legal board, fake swarm.**

## The fix shape (packs + wire)

| Wave | Parallel? | What | Owned files |
|------|-----------|------|-------------|
| Scouts | yes | Map domain APIs → flat tool catalogs | `.grok-swarm/scouts/*` only |
| Domain packs | **yes** | Implement handlers/schemas/tests for one domain | **NEW** disjoint pack files only |
| Wire | **no** (one task) | Merge packs into the real hub | Shared hub files only |
| Review + log | after wire | Audit + compound learnings | review note + `docs/solutions/` |

### Pack contract (conceptual)

Domain builders never touch the hub. They write e.g.:

- `…/packs/listsPack.ts`
- `…/packs/campaignsPack.ts`
- `…/__tests__/omniLists….test.ts`

Each pack exports declarations, Zod schemas, write-name sets, executeRead/Write handlers, i18n **fragments**, pending-arg fixtures.

The **single wire builder** imports packs and:

1. Spreads declarations into the hub declaration list  
2. Unions `WRITE_TOOL_NAMES` / schema-write sets  
3. Merges Zod maps  
4. Delegates `executeWrite` / dual `executeRead`  
5. Merges locale fragments + approval labels  
6. Merges pending-args fixtures  

Heavy thinking stays parallel in packs; hub ownership is a short mechanical glue task.

## Rules for parents (task create)

1. **Never** give two product features the same multi-file hub lease under a linear `--depends` chain of length ≥ 3.  
2. Prefer **many small tasks** with **pairwise disjoint** `--files` over phase monoliths.  
3. Use `--depends` for true data/order deps (e.g. “wire needs packs done”), **not** to serialize identical hubs.  
4. If domain work and hub work must both land, **split**: pack task(s) + wire task.  
5. Scouts, reviewers, loggers are real concurrent roles — not one-per-phase serial attachments.

## Mechanical enforcement

`swarm check` fails on **`serial_hub_chain`** when:

- ≥ **3** non-terminal tasks  
- linked by `depends_on`  
- consecutive pairs **share** owned files  
- the **intersection** of all chain members’ owned files has size ≥ **3**

Escape hatch (legacy in-flight boards only):

```bash
swarm check --allow-serial-hub
```

Do **not** use the escape hatch for new plans.

## Healthy board signal

```
RUNNING:  Scout A, Scout B, Scout C          (or DONE)
RUNNING:  Builder Pack Lists, Pack Campaigns, Pack Team
QUEUED:   Builder Wire (depends on 3 packs)
WAITING:  Reviewer, Logger
```

**Unhealthy:**

```
BUILDING: Phase 4 (hub lease)
ASSIGNED: Phase 5, Phase 6 (blocked on depends)
```

## Coordinator duty

If `swarm check` reports `serial_hub_chain`, **do not** dispatch builders on that board as-is. Escalate to parent: replan packs + wire (or cancel the chain). Coordinators never “fix” product code to break the chain.

## Related

- `SKILL.md` § Hot-hub adjudication  
- `templates/coordinator-prompt.md` hard rule  
- `templates/coordinator-cursor.md` parent checklist  
- Cherry-pick source: Sol (xhigh) + Grok plan agent (2026-08-07) — pack pattern from planner; exclusive hub owner from both  
