<!--
Shared protocol: every grok-swarm builder/reviewer run must apply /double-check
before claiming done. Coordinators enforce presence of a double-check report.
Canonical skill: {{SKILL_ROOT}}/../double-check/SKILL.md (also /double-check).
Include or paraphrase this block in builder/reviewer prompts.
-->

## Mandatory /double-check (before done)

Load and follow the **double-check** skill:
`{{SKILL_ROOT}}/../double-check/SKILL.md` (slash: `/double-check`).

Do **not** report `worker_done` / PASS / merge-ready until this pass is done.

### Steps (same as the skill)

1. **Restate** the task goal and what “complete” means (acceptance + owned files only).
2. **List verification angles** before inspecting (pick those that apply):
   - User-visible behavior (UI → also agent-browser if this is a visual task)
   - Data correctness / edge cases
   - Security, privacy, tenant isolation (if this repo is multi-tenant)
   - Error handling / recovery
   - Tests + gates (typecheck/lint/test for **this** repo)
   - Adjacent paths that could share the same bug
3. **Check each angle** with evidence (commands, diffs, screenshots). Prefer facts over reassurance. Treat TODOs, placeholders, fake success, and unrun gates as incomplete.
4. **Fix** in-scope failures you find (builders only). Reviewers do not edit product code — they REVISE / redispatch.
5. **Report** using the skill output shape (write to the path below when possible).

### Artifact (required)

**Canonical path (both locations when possible):**

1. Worktree: `.grok-swarm/double-check/{{TASK_ID}}.md` (relative to worktree root)
2. MAIN repo (if `{{REPO_PATH}}` is known): `{{REPO_PATH}}/.grok-swarm/double-check/{{TASK_ID}}.md`

Coordinator looks in **both** `$WT_PATH/.grok-swarm/double-check/<taskId>.md` and `MAIN/.grok-swarm/double-check/<taskId>.md`.

```markdown
Double-check result: complete / incomplete / partially complete

Verified:
- …

Fixed:
- …   (builders; omit if none)

Remaining risk:
- …
```

If result is **incomplete** or **partially complete**: do **not** claim done — keep building or set `blocked` with the remaining items.

Do **not** use alternate paths (`swarms/<id>/double-check/…` alone) unless you also write the canonical path above.
