# Rule: Double-check merge / mark-done gate (F1/F2)

**When it applies:** Any mega integrate merge, reconcile mark-done, force-pass eligibility that claims DC green, or editing `bin/mega-runtime.cjs` / `bin/double-check-gate.cjs` / coordinator merge protocol.

## Bad pattern

- Merge integrate or mark pack `done` because the coordinator prompt said DC was mandatory — without a file check.
- Treat “partially complete” / “incomplete” as pass.
- Reimplement `Double-check result:` parsing in mega/heal/swarm instead of calling `double-check-gate.cjs`.
- Auto-heal force-pass or merge when DC is missing (F1 is **never** `isAutoSafe`).
- Assume `megaMark` / CLI force-mark is gated — as of Task 6 it is **not** (follow-up).

## Good pattern

| Path | Gate |
|------|------|
| `reconcileMega` → mark done | `assertDoubleCheckBoard` → else `double-check-wait` (**F2**) |
| `mergeIntegrate` | Board unreadable → fail closed; done tasks present → complete DC (**F1**) |
| C5 / force-pass DC check | `doubleCheckCompleteForBoard` → **delegates** to gate module |
| Builder artifact | `.grok-swarm/double-check/<taskId>.md` with `Double-check result: complete` |

```js
const dcGate = require('./double-check-gate.cjs');
// COMPLETE only:
// /Double-check result:\s*complete\b/i
```

New mark-done or integrate entrypoints **must** call the gate (or document why tests-only `skipDoubleCheck`/`force`).

## Verify

```bash
rg -n "double-check-gate|assertDoubleCheckBoard|double-check-wait|edge F1|edge F2" bin/mega-runtime.cjs bin/double-check-gate.cjs
cd bin && node --test double-check-gate.test.mjs
# Incomplete / partial must fail; missing file must fail
```

## Related learning

`.grok-swarm/learnings/2026-07-15-double-check-gate-f1-f2.md`
