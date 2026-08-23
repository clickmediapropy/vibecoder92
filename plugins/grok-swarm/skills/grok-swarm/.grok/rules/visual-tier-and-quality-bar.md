# Rule: Visual tier budgets + BLOCKED≠REVISE + quality bar

**When it applies:** Any UI / mega visual review, coordinator visual gate, heal/force-pass, or editing `templates/visual-reviewer-prompt.md` / `templates/coordinator-prompt.md` / quality-bar docs.

## Bad pattern

- Dispatch full browser for every pack; expand smoke into full.
- Label auth-harness failure (proxy, wrong-origin JWT, missing TEST_*) as product REVISE and redispatch builders.
- Infinite visual redispatches or leave `status=review` with a dead visual PID.
- Force-pass high-severity product REVISE to “go faster”; skip typecheck/double-check.

## Good pattern

| Tier | Budget | Dispatch |
|------|--------|----------|
| full | ≤12 routes | Visual reviewer + DC |
| smoke | ≤4 happy-path | Visual reviewer + DC |
| gates_only | 0 browser | Code gates + DC only; integrate visual later |

| Status | Action |
|--------|--------|
| PASS + green gates/DC | merge |
| REVISE high | Mode C/B fix; re-visual (≤2 redispatches, then ×3 → blocked) |
| BLOCKED auth + green gates/DC | mega visual pass / force-pass with note — **not** builder REVISE |
| BLOCKED auth + red gates | fix gates first |

Always: same-origin login; unset proxies for visual; fill `{{VISUAL_TIER}}`.

## Verify

```bash
grep -E 'VISUAL_TIER|gates_only|Verdict taxonomy' templates/visual-reviewer-prompt.md
grep -E 'max 2 visual|Visual decision' templates/coordinator-prompt.md
test -f docs/2026-07-15-fast-quality-bar.md
```

## Related learning

`.grok-swarm/learnings/2026-07-15-visual-tier-budgets-and-quality-bar.md`
