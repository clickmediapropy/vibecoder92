# Grok Swarm Board — {{DATE}}

> Shared coordination hub for a Grok-CLI multi-agent swarm.
> **Coordinator:** Grok CLI daemon (`swarm coordinator start --daemon`) by default; parent agent only plans + launches.
> Each Builder/Reviewer is a `grok -p` headless run. Live state via `swarm task` / `swarm board` (event-sourced).
> This file is the human-readable mirror — refresh with `swarm board --sync`.

**Goal:** {{GOAL}}

---

## Task Breakdown

> Each task lists its owned files — **no file overlaps between parallel tasks** (`swarm task create` enforces this;
> overlaps require a `--depends` sequencing or `--force`). Run `swarm check` to validate the whole board.
> Status lifecycle: OPEN → ASSIGNED → PLANNING → BUILDING → REVIEW → DONE (or BLOCKED)

<!-- swarm:tasks:start -->
_(run `swarm board --sync` to fill this section from event state)_
<!-- swarm:tasks:end -->

---

## Dispatches

> One `swarm dispatch record` per builder/reviewer `grok -p` run (task, worktree, log, PID, sessionId, base ref).
> Query live: `swarm dispatch list [--status running] [--json]`.

---

## Reviewer

**Role:** read-only `grok -p` pass with `--permission-mode plan` (CLI blocks edits); coordinator verifies via `git status`/`git diff`.
**Status:** WAITING
**Findings:** —

---

## Coordinator Notes

> Orchestrator-only: dispatch decisions, monitoring milestones, verification results, fix-loop rounds.
<!-- Coordinator updates here -->

---

## Completed Work Log

<!-- swarm:done:start -->
_(run `swarm board --sync` to fill this section from event state)_
<!-- swarm:done:end -->
