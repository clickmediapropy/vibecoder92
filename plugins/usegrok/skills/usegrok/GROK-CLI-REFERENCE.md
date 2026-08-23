# Grok CLI Reference

> Generated from `grok -h` and subcommand help on **grok 0.2.87** (2026-07-07).
> Run `grok update` if your version differs. For orchestration patterns, see `SKILL.md`.

**Grok Build** is xAI's agentic coding CLI. Default mode is an interactive TUI; use `-p` / `--single` for headless one-shot runs.

```bash
grok -h                    # top-level help
grok help <subcommand>     # help for some nested commands (e.g. grok help mcp list)
grok <cmd> <sub> -h        # help for most subcommands (e.g. grok mcp add -h)
```

---

## Quick reference

| Intent | Command |
|--------|---------|
| Interactive session | `grok` or `grok "fix the bug"` |
| Headless single turn | `grok -p "prompt" --always-approve` |
| Resume last session | `grok -c` |
| Resume by ID | `grok -r <SESSION_ID>` (with `--cwd <worktree-path>` when continuing existing worktree) |
| Resume into new worktree | `grok -w -r <SESSION_ID>` (fork; xAI docs) |
| List models | `grok models` |
| List sessions | `grok sessions list` |
| New isolated git worktree | `grok --worktree feat-name "task"` |
| Inspect project config | `grok inspect` |
| Sign in | `grok login` |
| Update CLI | `grok update` |

---

## Default invocation (no subcommand)

```text
grok [OPTIONS] [PROMPT] [COMMAND]
```

Starts the **Grok Build TUI** (terminal UI). An optional `[PROMPT]` seeds the first message.

### Session & workspace

| Flag | Description |
|------|-------------|
| `-c`, `--continue` | Continue the most recent session for the current working directory |
| `-r`, `--resume [<SESSION_ID>]` | Resume a session by ID, or the most recent if omitted |
| `-s`, `--session-id <UUID>` | Use a specific UUID for a **new** conversation (must not already exist). With `--resume`/`--continue`, only valid with `--fork-session` |
| `--fork-session` | When resuming, create a new session ID instead of reusing the original |
| `--restore-code` | Check out the original session's commit when resuming |
| `--cwd <CWD>` | Working directory |
| `-w`, `--worktree [<NAME>]` | Start in a new git worktree, optionally named |
| `--worktree-ref`, `--ref <REF>` | Branch, tag, or commit to base the worktree on (default: current HEAD) |

### Headless / scripting

| Flag | Description |
|------|-------------|
| `-p`, `--single <PROMPT>` | Single-turn prompt; prints response to stdout and exits |
| `--prompt-file <PATH>` | Single-turn prompt from a file |
| `--prompt-json <JSON>` | Single-turn prompt as JSON content blocks |
| `--output-format <FMT>` | `plain` (default), `json`, or `streaming-json` |
| `--json-schema <SCHEMA>` | Constrain output to JSON matching schema; implies `--output-format json` |
| `--check` | Append a self-verification loop (headless only) |
| `--best-of-n <N>` | Run task N ways in parallel and pick the best (headless only) |
| `--verbatim` | Send the prompt exactly as given |

### Model & reasoning

| Flag | Description |
|------|-------------|
| `-m`, `--model <MODEL>` | Model ID (`grok models` to list) |
| `--effort <LEVEL>` | `low`, `medium`, `high`, `xhigh`, `max` |
| `--reasoning-effort <EFFORT>` | Reasoning effort for reasoning models |
| `--max-turns <N>` | Maximum agent turns |

### Agents & tools

| Flag | Description |
|------|-------------|
| `--agent <NAME>` | Agent name or definition file path |
| `--agents <JSON>` | Inline subagent definitions as JSON |
| `--tools <TOOLS>` | Built-in tools to allow (comma-separated) |
| `--disallowed-tools <TOOLS>` | Built-in tools to remove (comma-separated) |
| `--allow <RULE>` | Permission allow rule (Claude Code: `--allowedTools`) |
| `--deny <RULE>` | Permission deny rule (Claude Code: `--disallowedTools`) |
| `--permission-mode <MODE>` | `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan` |
| `--always-approve` | Auto-approve all tool executions |
| `--no-subagents` | Disable subagent spawning |
| `--disable-web-search` | Disable web search and web fetch tools |

### Memory & planning

| Flag | Description |
|------|-------------|
| `--experimental-memory` | Enable cross-session memory |
| `--no-memory` | Disable cross-session memory for this session |
| `--no-plan` | Disable plan mode |

### System prompt & rules

| Flag | Description |
|------|-------------|
| `--system-prompt-override <PROMPT>` | Override the agent system prompt |
| `--rules <RULES>` | Extra rules appended to the system prompt |

### UI & display

| Flag | Description |
|------|-------------|
| `--minimal` | Scrollback-native rendering (experimental) |
| `--no-alt-screen` | Run inline instead of alternate screen |
| `--oauth` | Use OAuth when welcome screen starts authentication |

### Sandbox & security

| Flag | Description |
|------|-------------|
| `--sandbox <PROFILE>` | Sandbox profile for filesystem/network (`GROK_SANDBOX` env) |

### Debugging & infra

| Flag | Description |
|------|-------------|
| `--debug` | Enable debug logging |
| `--debug-file <FILE>` | Write debug logs to FILE |
| `--leader-socket <PATH>` | Custom leader socket (default `~/.grok/leader.sock`) |
| `-v`, `--version` | Print version |
| `-h`, `--help` | Print help |

---

## Commands

### `grok agent` — Non-interactive agent backends

Run Grok without the interactive UI. Subcommands:

#### `grok agent stdio`

Run the agent over stdio (for SDK/IDE integration).

#### `grok agent headless`

Run headlessly over the Grok WebSocket relay.

| Option | Description |
|--------|-------------|
| `--grok-ws-origin` | WebSocket origin override |
| `--grok-ws-url` | WebSocket URL override |

#### `grok agent serve`

Run the agent as a WebSocket server.

| Option | Description |
|--------|-------------|
| `--bind <ADDR>` | Listen address (default `127.0.0.1:2419`) |
| `--secret <SECRET>` | Client auth token (`GROK_AGENT_SECRET` env; auto-generated if omitted) |
| `--remote <URL>` | Remote agent URL for proxy mode |

#### `grok agent leader`

Run as the shared **leader** process for other clients.

| Option | Description |
|--------|-------------|
| `--no-exit-on-disconnect` | Keep leader running after last client disconnects |
| `--relay-on-demand` | Defer grok.com relay until first headless IPC client |
| `--no-auto-update` | Disable periodic auto-update checks |

**Parent `grok agent` options** (shared):

| Option | Description |
|--------|-------------|
| `--reauth`, `--reauthenticate` | Run authentication before starting |
| `-m`, `--model` | Model ID |
| `--always-approve` | Auto-approve tools |
| `--agent-profile <PATH>` | Agent profile file |
| `--plugin-dir <DIR>` | Load plugin directory (repeatable; SDK injection) |
| `--leader` | Connect to shared leader instead of new agent |
| `--no-leader` | Start new agent even when config enables leader |
| `--cli-chat-proxy-base-url` | Override CLI chat proxy |
| `--xai-api-base-url` | Override xAI API base URL |

---

### `grok completions <SHELL>`

Generate shell completion scripts.

**Shells:** `bash`, `elvish`, `fish`, `powershell`, `zsh`

```bash
grok completions zsh > ~/.zfunc/_grok
```

---

### `grok dashboard`

Open the **Agent Dashboard** view at startup (instead of the default TUI entry).

---

### `grok export <SESSION_ID> [OUTPUT]`

Export a session transcript as Markdown.

| Option | Description |
|--------|-------------|
| `-c`, `--clipboard` | Copy to clipboard instead of stdout |

```bash
grok export abc123 session.md
grok export abc123 -c   # clipboard
```

---

### `grok import [TARGETS]...`

Import sessions into Grok.

| Option | Description |
|--------|-------------|
| `--list` | List available sessions without importing |
| `--json` | NDJSON output to stdout |

Omit `TARGETS` to import all available sessions. Targets can be session IDs or `.jsonl` paths.

---

### `grok inspect`

Show the configuration Grok discovers for the current directory (project rules, skills, permissions).

| Option | Description |
|--------|-------------|
| `--json` | Machine-readable JSON |

```bash
grok inspect --json --cwd /path/to/repo
```

---

### `grok leader` — Manage running leader processes

Shared backend that multiple Grok clients can attach to.

#### `grok leader list`

List running leader processes (`--json` for machine output).

#### `grok leader info`

Show details for a leader process.

| Option | Description |
|--------|-------------|
| `--pid <PID>` | Leader PID from `grok leader list` |

#### `grok leader kill`

Stop **all** running leader processes.

#### `grok leader profile`

CPU profiling for a leader process.

| Subcommand | Description |
|------------|-------------|
| `status` | Show profiling status (`--pid`, `--json`) |
| `start` | Start profiling (`--pid`, `--output`, `--frequency-hz`) |
| `stop` | Stop profiling (`--pid`) |

---

### `grok login`

Sign in to Grok.

| Option | Description |
|--------|-------------|
| `--oauth` | Grok OAuth via auth.x.ai |
| `--device-auth`, `--device-code` | Device-code auth for headless/remote |

```bash
grok login
grok login --device-auth   # CI / SSH without browser
```

**Headless alternative:** `export XAI_API_KEY="xai-..."`

---

### `grok logout`

Sign out and clear cached credentials.

---

### `grok mcp` — MCP server configuration

Manage Model Context Protocol servers in `~/.grok/config.toml` (user) or `./.grok/config.toml` (project).

#### `grok mcp list`

List configured MCP servers (`--json`).

#### `grok mcp add <NAME> [COMMAND_OR_URL] [ARGS]...`

Add or update an MCP server.

| Option | Description |
|--------|-------------|
| `-t`, `--transport` | `stdio` (default), `http`, `sse` |
| `-s`, `--scope` | `user` (default) or `project` |
| `-e`, `--env KEY=value` | Env var for server process (repeatable) |
| `-H`, `--header NAME: VALUE` | HTTP header for remote servers |

```bash
# stdio server
grok mcp add xcode -- xcrun mcpbridge

# with env
grok mcp add postgres -e DATABASE_URL=postgres://localhost/mydb -- npx -y @modelcontextprotocol/server-postgres

# remote HTTP
grok mcp add --transport http sentry https://mcp.sentry.dev/mcp

# project-scoped
grok mcp add --scope project github -- npx -y @modelcontextprotocol/server-github
```

#### `grok mcp remove <NAME>`

Remove a server (`-s user|project`; omit scope to search all).

#### `grok mcp doctor [NAME]`

Diagnose MCP configuration and connectivity (`--json`).

---

### `grok memory` — Cross-session memory

#### `grok memory clear`

Clear memory files.

| Option | Description |
|--------|-------------|
| `--workspace` | Clear workspace memory (MEMORY.md, sessions/, index.sqlite) |
| `--global` | Clear global MEMORY.md |
| `--all` | Both workspace and global |
| `-y`, `--yes` | Skip confirmation |

Enable memory in sessions with `--experimental-memory`; disable with `--no-memory`.

---

### `grok models`

List available model IDs and exit. Use IDs with `-m` / `--model`.

```bash
grok models
```

---

### `grok plugin` — Plugins and marketplaces

#### `grok plugin list`

List installed plugins (`--json`; `--available` with `--json` includes marketplace).

#### `grok plugin install <SOURCE>`

Install from git URL, GitHub shorthand (`user/repo`), or local path. Supports `@ref` and `#subdir`.

| Option | Description |
|--------|-------------|
| `--trust` | Trust immediately (skip confirmation) |

#### `grok plugin uninstall <NAME>` (`rm`, `remove`)

Uninstall by name.

| Option | Description |
|--------|-------------|
| `--confirm` | Skip confirmation for multi-plugin repos |
| `--keep-data` | Preserve plugin data directory |

#### `grok plugin update [NAME]`

Update one plugin or all if name omitted.

#### `grok plugin enable <NAME>` / `grok plugin disable <NAME>`

Enable or disable without uninstalling.

#### `grok plugin details <NAME>`

Show plugin component inventory.

#### `grok plugin validate [PATH]`

Validate plugin manifest (default: current directory).

#### `grok plugin tag [PATH]`

Create release git tag from manifest version.

| Option | Description |
|--------|-------------|
| `--push` | Push tag to remote |
| `-f`, `--force` | Tag even if dirty tree or tag exists |
| `--dry-run` | Print without creating |

#### `grok plugin marketplace`

Manage marketplace sources.

| Subcommand | Description |
|------------|-------------|
| `list` | List sources and plugins (`--json`) |
| `add <URL>` | Add git URL or GitHub shorthand |
| `remove <URL>` | Remove source and uninstall its plugins |
| `update [NAME]` | Refresh one or all sources |

---

### `grok sessions` — Session history

#### `grok sessions list`

List recent sessions (same as search with no query).

| Option | Description |
|--------|-------------|
| `-n`, `--limit <N>` | Max sessions (default 20) |

#### `grok sessions search <QUERY>`

Search summaries and first prompts.

#### `grok sessions delete <ID>`

Permanently delete a session from history.

```bash
grok sessions list -n 10
grok sessions search "webhook"
grok -r <ID> --cwd <worktree-path>    # resume in existing worktree (Mode C)
grok -w -r <ID> -p "..."              # resume into a fresh worktree (Mode D fork)
```

**Session + worktree:** `-r`/`-c` bind to the session's original directory. When continuing an **existing** named worktree, always pass `--cwd "$WT_PATH"` with `-r`. Do not combine `-r` with `--worktree` on existing trees. `--cwd` to a worktree path alone does not reliably set shell cwd — for new tool runs, `cd` into the worktree or use `--cwd "$MAIN_REPO" --worktree name` for new work.

---

### `grok setup`

Fetch and install managed configuration (enterprise/managed Grok setups).

---

### `grok trace <SESSION_ID>`

Export or upload session trace data.

| Option | Description |
|--------|-------------|
| `--local` | Save locally only, skip remote upload |
| `-o`, `--output <PATH>` | Output path (default `$GROK_HOME/trace-exports/<id>.tar.gz`) |
| `--json` | Machine-readable JSON metadata |

---

### `grok update`

Check for updates or install a specific version.

| Option | Description |
|--------|-------------|
| `--check` | Check without installing (`--json` for machine output) |
| `--force-reinstall` | Re-download even if up to date |
| `--version <VERSION>` | Install specific version (e.g. `0.1.150`) |
| `--alpha` | Switch to alpha channel |
| `--stable` | Switch to stable channel (default, weekly) |

```bash
grok update --check
grok update
grok update --version 0.2.87
```

---

### `grok version` (`v`)

Print version information (`--json`).

---

### `grok worktree` — Git worktree management

Grok tracks worktrees it creates (via `--worktree` flag). Distinct from raw `git worktree`.

#### `grok worktree list`

List tracked worktrees.

| Option | Description |
|--------|-------------|
| `--repo <REPO>` | Filter by repo |
| `--type <TYPE>` | Filter by type |
| `--json` | JSON output |
| `--all` | Include all entries |

#### `grok worktree show <ID_OR_PATH>`

Show details for one worktree.

#### `grok worktree rm <IDS>...`

Remove worktrees.

| Option | Description |
|--------|-------------|
| `-f`, `--force` | Force removal |
| `--dry-run` | Preview without removing |

#### `grok worktree gc`

Garbage-collect orphaned/stale worktrees.

| Option | Description |
|--------|-------------|
| `--dry-run` | Preview |
| `--max-age <DURATION>` | Age threshold |
| `-f`, `--force` | Force GC |

#### `grok worktree db`

Worktree database maintenance.

| Subcommand | Description |
|------------|-------------|
| `rebuild` | Rebuild DB from filesystem scan |
| `stats` | Show DB statistics |
| `path` | Print DB file path |

```bash
grok --worktree fix-bug "implement feature"
grok worktree list
grok worktree rm <id> -f
grok worktree gc --dry-run
```

---

### `grok wrap <CMD>...`

Run any command with local clipboard support (OSC 52 → system clipboard). Useful inside Docker/SSH where clipboard doesn't work natively.

```bash
grok wrap docker exec -it my-container bash
```

---

## Common workflows

### Headless automation (scripts / CI)

```bash
grok -p "Run tests and fix failures" \
  --cwd /path/to/repo \
  -m grok-4.6 \
  --always-approve \
  --output-format json
```

### Fix loop after verification failure

```bash
grok -c -p "Fix: typecheck failed with …" \
  --cwd /path/to/repo \
  --always-approve
```

### Parallel isolated tasks (Mode A — from main repo)

```bash
REPO=/path/to/repo
BASE=$(git -C "$REPO" rev-parse HEAD)

# NO trailing & in Cursor-style harnesses — use block_until_ms: 0 instead
grok --prompt-file /tmp/backend.md --cwd "$REPO" --worktree wt-backend --worktree-ref "$BASE" \
  -m grok-4.6 --always-approve --output-format streaming-json > /tmp/backend.log 2>&1

grok --prompt-file /tmp/frontend.md --cwd "$REPO" --worktree wt-frontend --worktree-ref "$BASE" \
  -m grok-4.6 --always-approve --output-format streaming-json > /tmp/frontend.log 2>&1

grok worktree list
```

See also: `dispatch-grok.sh (grok-swarm plugin) --mode new ...`

### Read-only audit

```bash
grok -p "Audit only. Do NOT edit files." \
  --disallowed-tools "search_replace,write" \
  --always-approve
```

---

## Config & paths

| Path | Purpose |
|------|---------|
| `~/.grok/config.toml` | User-level MCP and config |
| `./.grok/config.toml` | Project-level MCP (shared with team) |
| `~/.grok/leader.sock` | Default leader Unix socket |
| `$GROK_HOME/trace-exports/` | Default trace export directory |

---

## Environment variables

| Variable | Purpose |
|----------|---------|
| `XAI_API_KEY` | API key for headless auth |
| `GROK_SANDBOX` | Default sandbox profile |
| `GROK_AGENT_SECRET` | WebSocket server secret (`grok agent serve`) |
| `GROK_HOME` | Grok home directory (traces, etc.) |

---

## See also

- `SKILL.md` in this directory — orchestration patterns for delegating to `grok -p`
- `grok inspect` — what Grok loads from your repo (AGENTS.md, skills, rules)
- xAI Grok Build documentation (when available online)
