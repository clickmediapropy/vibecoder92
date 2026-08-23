# grok-swarm — Claude Code plugin

Run an **autonomous multi-agent coding swarm on Grok CLI** from Claude Code. Claude plans the tasks; a detached Grok coordinator dispatches builders into isolated git worktrees, verifies, fixes, merges, and reports on a local dashboard. Repo-agnostic, zero third-party deps (Node + `grok` only).

## Prerequisites

- [Grok CLI](https://docs.x.ai/docs/grok-cli) ≥ 1.0.3, authenticated (`grok login --device-auth` or `XAI_API_KEY`)
- Node ≥ 18, git

## Install

```
/plugin marketplace add clickmediapropy/vibecoder92
/plugin install grok-swarm@vibecoder92
```

Local dev: `claude --plugin-dir /path/to/vibecoder92/plugins/grok-swarm`.

## Usage

```
/grok-swarm launch <goal>     # plan tasks, launch coordinator + dashboard, exit
/grok-swarm pause | resume
```

Dashboard: http://127.0.0.1:4599/ . The `swarm` CLI lives at `${CLAUDE_PLUGIN_ROOT}/skills/grok-swarm/bin/swarm` — add it to `PATH` or call it by full path.

## Bundled skills

| Skill | Role |
| --- | --- |
| `grok-swarm` | Orchestration (SKILL.md + reference.md + `bin/` + templates + dashboard) |
| `usegrok` | Canonical headless `grok -p` contract and flag reference |
| `double-check` | Mandatory pre-merge self-review protocol every builder runs |

State lives in `<repo>/.grok-swarm/` and worktrees under `~/.grok/worktrees/`; add `.grok-swarm/` to your repo's `.gitignore`.

---

Made by [nicodelgado.dev](https://nicodelgado.dev)
