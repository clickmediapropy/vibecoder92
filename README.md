# vibecoder92 — Claude Code plugins & skills

Plugin marketplace. Install:

```
/plugin marketplace add clickmediapropy/vibecoder92
/plugin install <plugin>@vibecoder92
```

| Plugin | What it does |
| --- | --- |
| [grok-swarm](plugins/grok-swarm) | Autonomous multi-agent coding swarms on Grok CLI (parallel worktree builders, detached coordinator, dashboard, verify/fix/merge). |
| [usegrok](plugins/usegrok) | Delegate a single coding task to Grok CLI headless (`grok -p`); Claude orchestrates and verifies. |

Each plugin lives in `plugins/<name>/` with its own `.claude-plugin/plugin.json` and README. MIT.

---

Made by [nicodelgado.dev](https://nicodelgado.dev)
