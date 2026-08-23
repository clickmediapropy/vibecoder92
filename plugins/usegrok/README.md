# usegrok — Claude Code plugin

Delegate planning, auditing, fixing, or any read/write coding task to **Grok CLI** in headless mode (`grok -p`). Claude stays orchestrator + verifier: it crafts a self-contained prompt, runs Grok, and checks the result. Ships `GROK-CLI-REFERENCE.md` with the full flag table.

## Prerequisites
- [Grok CLI](https://docs.x.ai/docs/grok-cli) ≥ 1.0.3, authenticated (`grok login --device-auth` or `XAI_API_KEY`)

## Install
```
/plugin marketplace add clickmediapropy/vibecoder92
/plugin install usegrok@vibecoder92
```

## Usage
`/usegrok <task>` — single task on Grok. For multi-task parallel builds use the `grok-swarm` plugin (which bundles this skill).
