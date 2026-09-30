#!/usr/bin/env node
/*
 * grok-swarm — zero-dependency coordination CLI for multi-agent coding swarms
 * driven by Grok CLI (`grok -p`) headless worker runs.
 *
 * Workspace lives in the TARGET repo at <repo>/.grok-swarm/ :
 *   SWARM_BOARD.md        shared human-readable board (synced via `swarm board --sync`)
 *   agents.json           registered agent labels + roles
 *   inbox/<label>/*.json  file-based mailboxes (mirrors bs-mail)
 *   plan/events/*.json    event-sourced goals + tasks (mirrors bs-swarm)
 *   dispatches/*.json     one record per builder/reviewer grok run
 *   transcript/*.json     append-only copy of every message sent
 *   nudges/<label>.txt    last-message marker per agent
 *
 * The sender/identity is taken from the SWARM_AGENT_NAME env var.
 *
 * Subcommands:
 *   init <repoPath> [--goal "..."] [--agents "Label:role,..."] [--fresh]
 *   mail send --to <label|@all> --type <T> --body "..."
 *   mail check [--consume|--inject|--json]
 *   mail peek [--json]                        # non-consuming; exit code 0=mail, 1=empty
 *   task create --title --owner --files --acceptance [--depends] [--goal] [--force]
 *   task update --id --status --note [--owner --files --acceptance --blocked] [--force]
 *   task list [--owner X] [--status S] [--json]
 *   task ready [--json]                       # open/assigned tasks whose deps are all done
 *   goal create|update --title [--status]
 *   agent register --label "Builder 3" [--role builder]
 *   agent list [--json]
 *   dispatch record --task <id> --agent <label> [--worktree N --worktree-path P
 *                    --log F --pid N --session S --base REF --status running]
 *   dispatch update --id <id> [--status --session --pid --exit-code --note]
 *   dispatch list [--task T] [--agent A] [--status S] [--json]
 *   check [--json] [--allow-serial-hub]       # validate board: overlaps, dep cycles, missing deps, serial hub chains
 *   state
 *   board [--sync]                            # --sync rewrites SWARM_BOARD.md marker sections
 *   coordinator start|status|stop             # autonomous Grok CLI coordinator daemon
 *   launch [<repo>]                           # init? + dashboard + coordinator start
 *   mega write-plan|check|status|launch|mark|cleanup|doctor|watch
 *   heal [doctor|status|stop] | heal --daemon   # self-monitor / auto-heal agent
 *   watch [<mega-id>]                         # live task board, OR mega+coordinator status
 *   cleanup --swarm <id>                      # tear down one swarm (worktrees/PIDs/archive)
 *   help [subcommand]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const processKill = require('./process-kill.cjs');
const hostStats = require('./host-stats.cjs');
const { analyzeDispatchLog } = require('./log-analyze.cjs');
const { buildWorkerResumeCommand } = require('./resume-cmd.cjs');
const { workerModel, coordinatorModel } = require('./model-pin.cjs');
const { buildOperatorGuide } = require('./operator-guide.cjs');

const MAIL_TYPES = ['message', 'status', 'escalation', 'worker_done', 'swarm_complete'];
const GOAL_STATUSES = new Set(['active', 'completed', 'blocked', 'cancelled']);
const TASK_STATUSES = new Set(['open', 'assigned', 'planning', 'building', 'review', 'done', 'blocked', 'cancelled']);
const DISPATCH_STATUSES = new Set(['running', 'done', 'failed', 'killed', 'paused']);
const TERMINAL_TASK = new Set(['done', 'cancelled']);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function genId(prefix) {
  const base = Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
  return prefix ? prefix + '-' + base : base;
}

function parseArgs(argv) {
  const args = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i];
    if (!cur.startsWith('--')) {
      positional.push(cur);
      continue;
    }
    const key = cur.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = 'true';
    }
  }
  args._ = positional;
  return args;
}

function die(message) {
  console.error(message);
  process.exit(1);
}

function agentName() {
  return process.env.SWARM_AGENT_NAME || 'unknown';
}

function bounded(value, max) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function requiredString(value, max, label) {
  const out = bounded(value, max);
  if (!out) die('Missing required --' + label);
  return out;
}

function list(value, maxItems, maxLength) {
  if (!value || value === 'true') return [];
  const seen = new Set();
  const out = [];
  for (const raw of String(value).split(',')) {
    const entry = raw.trim();
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry.length > maxLength ? entry.slice(0, maxLength) : entry);
    if (out.length >= maxItems) break;
  }
  return out;
}

function writeJsonPretty(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function writeJsonLine(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// workspace resolution — walk up from --cwd / PWD to find .grok-swarm/, then
// resolve one swarm instance under .grok-swarm/swarms/<id>/ (multi-swarm).
// ---------------------------------------------------------------------------
const SWARM_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

function findWorkspace(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  while (true) {
    const candidate = path.join(dir, '.grok-swarm');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function registryFile(registryRoot) {
  return path.join(registryRoot, 'registry.json');
}

function readRegistry(registryRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryFile(registryRoot), 'utf8'));
    if (parsed && Array.isArray(parsed.swarms)) return parsed;
  } catch { /* absent or corrupt */ }
  return null;
}

function writeRegistry(registryRoot, registry) {
  writeJsonPretty(registryFile(registryRoot), registry);
}

function isLegacyLayout(registryRoot) {
  if (readRegistry(registryRoot)) return false;
  const legacyEvents = path.join(registryRoot, 'plan', 'events');
  const legacyDispatches = path.join(registryRoot, 'dispatches');
  const hasFiles = (dir) => {
    try { return fs.readdirSync(dir).some((f) => f.endsWith('.json')); } catch { return false; }
  };
  return hasFiles(legacyEvents) || hasFiles(legacyDispatches) ||
    fs.existsSync(path.join(registryRoot, 'SWARM_BOARD.md'));
}

const LEGACY_ENTRIES = ['plan', 'inbox', 'dispatches', 'transcript', 'nudges',
  'SWARM_BOARD.md', 'agents.json', 'pause.json', 'pause-history'];

function migrateLegacyWorkspace(registryRoot) {
  const dest = path.join(registryRoot, 'swarms', 'default');
  fs.mkdirSync(dest, { recursive: true });
  let moved = 0;
  for (const name of LEGACY_ENTRIES) {
    const src = path.join(registryRoot, name);
    if (!fs.existsSync(src)) continue;
    fs.renameSync(src, path.join(dest, name));
    moved += 1;
  }
  // Root dashboard pid/log stay at the registry root (unified server), but a
  // stale legacy pidfile pointing at a dead server is harmless either way.
  let title = 'default';
  try {
    const eventsDir = path.join(dest, 'plan', 'events');
    for (const f of fs.readdirSync(eventsDir).filter((x) => x.endsWith('.json')).sort()) {
      const ev = JSON.parse(fs.readFileSync(path.join(eventsDir, f), 'utf8'));
      if (ev && ev.goal && ev.goal.title) { title = ev.goal.title; break; }
    }
  } catch { /* keep default title */ }
  const registry = {
    version: 1,
    default: 'default',
    swarms: [{ id: 'default', title, status: 'active', createdAt: Date.now() }],
  };
  writeRegistry(registryRoot, registry);
  console.error('Migrated legacy workspace -> swarms/default (' + moved + ' entries). Use --swarm default or export SWARM_ID=default.');
  return registry;
}

function ensureRegistry(registryRoot) {
  let registry = readRegistry(registryRoot);
  if (!registry && isLegacyLayout(registryRoot)) {
    registry = migrateLegacyWorkspace(registryRoot);
  }
  if (!registry) {
    registry = { version: 1, default: null, swarms: [] };
  }
  return registry;
}

function buildWorkspace(registryRoot, swarmId) {
  const root = path.join(registryRoot, 'swarms', swarmId);
  return {
    repoRoot: path.dirname(registryRoot),
    registryRoot,
    swarmId,
    root,
    board: path.join(root, 'SWARM_BOARD.md'),
    agentsFile: path.join(root, 'agents.json'),
    inbox: path.join(root, 'inbox'),
    nudges: path.join(root, 'nudges'),
    transcript: path.join(root, 'transcript'),
    plan: path.join(root, 'plan'),
    events: path.join(root, 'plan', 'events'),
    dispatches: path.join(root, 'dispatches'),
    pauseFile: path.join(root, 'pause.json'),
    pauseHistory: path.join(root, 'pause-history'),
  };
}

function requireRegistryRoot(args) {
  const registryRoot = findWorkspace(args.cwd);
  if (!registryRoot) {
    die('No .grok-swarm/ workspace found (searched up from ' + path.resolve(args.cwd || process.cwd()) + '). Run: swarm init <repoPath>');
  }
  return registryRoot;
}

// Resolution precedence: --swarm > SWARM_ID env > single-swarm auto-select >
// registry.default > die with a helpful hint.
function resolveSwarmId(registry, args, { forDisplay = false } = {}) {
  const explicit = (args.swarm && args.swarm !== 'true' ? args.swarm : null) || process.env.SWARM_ID || null;
  if (explicit) {
    if (!registry.swarms.some((s) => s.id === explicit)) {
      die('Unknown swarm "' + explicit + '". Registered: ' +
        (registry.swarms.map((s) => s.id).join(', ') || '(none)') + '  (see: swarm swarms list)');
    }
    return explicit;
  }
  if (registry.swarms.length === 1) return registry.swarms[0].id;
  if (registry.default && registry.swarms.some((s) => s.id === registry.default)) return registry.default;
  if (registry.swarms.length === 0) {
    die('No swarms registered in this workspace. Run: swarm init <repoPath> --name <slug>');
  }
  if (forDisplay) return null;
  die('Multiple swarms registered (' + registry.swarms.map((s) => s.id).join(', ') +
    ') and no selection. Pass --swarm <id>, export SWARM_ID=<id>, or set a default: swarm swarms use <id>');
}

function requireWorkspace(args) {
  const registryRoot = requireRegistryRoot(args);
  const registry = ensureRegistry(registryRoot);
  const swarmId = resolveSwarmId(registry, args);
  const ws = buildWorkspace(registryRoot, swarmId);
  if (!fs.existsSync(ws.root)) {
    die('Swarm "' + swarmId + '" directory missing: ' + ws.root + ' (run: swarm init <repoPath> --name ' + swarmId + ')');
  }
  return ws;
}

function readPause(ws) {
  if (!fs.existsSync(ws.pauseFile)) return null;
  try { return JSON.parse(fs.readFileSync(ws.pauseFile, 'utf8')); } catch { return null; }
}

function readAgents(ws) {
  if (!fs.existsSync(ws.agentsFile)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(ws.agentsFile, 'utf8'));
    return Array.isArray(parsed) ? parsed : (Array.isArray(parsed.agents) ? parsed.agents : []);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
function templatePath(name) {
  return path.join(path.dirname(__dirname), 'templates', name || 'SWARM_BOARD.md');
}

function writeCoordinatorNudge(ws) {
  const tpl = templatePath('coordinator-cursor.md');
  if (!fs.existsSync(tpl)) return;
  const body = fs.readFileSync(tpl, 'utf8');
  fs.mkdirSync(ws.nudges, { recursive: true });
  fs.writeFileSync(path.join(ws.nudges, 'Coordinator.txt'), body, 'utf8');
}

function initCommand(argv) {
  const args = parseArgs(argv);
  const repoArg = args._[0] || args.repo || args.cwd || process.cwd();
  const repo = path.resolve(repoArg);
  if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) {
    die('Repo path does not exist or is not a directory: ' + repo);
  }
  const registryRoot = path.join(repo, '.grok-swarm');
  fs.mkdirSync(registryRoot, { recursive: true });
  const registry = ensureRegistry(registryRoot);

  // Swarm slug: --name > SWARM_ID env > 'default' (only when unambiguous).
  let swarmId = (args.name && args.name !== 'true' ? args.name : null) ||
    (args.swarm && args.swarm !== 'true' ? args.swarm : null) || null;
  if (!swarmId) {
    if (args.fresh === 'true' && registry.swarms.length > 1) {
      die('init --fresh with multiple swarms registered requires --name <slug> (which swarm to reset?)');
    }
    swarmId = registry.swarms.length === 1 ? registry.swarms[0].id : 'default';
  }
  if (!SWARM_ID_RE.test(swarmId)) {
    die('Invalid swarm name "' + swarmId + '" — use a slug matching ' + SWARM_ID_RE);
  }

  const root = path.join(registryRoot, 'swarms', swarmId);

  // Detect pre-existing state for THIS swarm instance.
  const preEventsDir = path.join(root, 'plan', 'events');
  const hasStaleEvents = fs.existsSync(preEventsDir) &&
    fs.readdirSync(preEventsDir).some((f) => f.endsWith('.json'));

  if (args.fresh === 'true' && fs.existsSync(root)) {
    // Archive ONLY this swarm instance into .grok-swarm/archive-<timestamp>/<id>/.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archiveDir = path.join(registryRoot, 'archive-' + stamp, swarmId);
    fs.mkdirSync(path.dirname(archiveDir), { recursive: true });
    fs.renameSync(root, archiveDir);
    console.log('Archived previous swarm state (swarm "' + swarmId + '") to ' + archiveDir);
  } else if (hasStaleEvents) {
    console.log('');
    console.log('*** WARNING: existing swarm state found at ' + root + ' ***');
    console.log('*** Previous goals/tasks/mail will be REUSED, which pollutes the board and dashboard. ***');
    console.log('*** To reset this swarm, run: swarm init ' + repo + ' --name ' + swarmId + ' --fresh ***');
    console.log('*** For a separate concurrent mission, run: swarm init ' + repo + ' --name <new-slug> ***');
    console.log('');
  }

  fs.mkdirSync(path.join(root, 'inbox'), { recursive: true });
  fs.mkdirSync(path.join(root, 'nudges'), { recursive: true });
  fs.mkdirSync(path.join(root, 'transcript'), { recursive: true });
  fs.mkdirSync(path.join(root, 'plan', 'events'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dispatches'), { recursive: true });

  // Register / refresh the instance in registry.json.
  const goalTitle = bounded(args.goal, 240);
  const entry = registry.swarms.find((s) => s.id === swarmId);
  if (entry) {
    if (goalTitle) entry.title = goalTitle;
    entry.status = 'active';
  } else {
    registry.swarms.push({ id: swarmId, title: goalTitle || swarmId, status: 'active', createdAt: Date.now() });
  }
  if (!registry.default || !registry.swarms.some((s) => s.id === registry.default)) {
    registry.default = swarmId;
  }
  writeRegistry(registryRoot, registry);

  const goal = bounded(args.goal, 2000) || '(set the swarm goal with: swarm goal create --title "...")';

  // Board from template (fallback to a minimal inline board).
  const boardFile = path.join(root, 'SWARM_BOARD.md');
  if (!fs.existsSync(boardFile)) {
    let board;
    const tpl = templatePath('SWARM_BOARD.md');
    const today = new Date().toISOString().slice(0, 10);
    if (fs.existsSync(tpl)) {
      board = fs.readFileSync(tpl, 'utf8')
        .replace(/{{DATE}}/g, today)
        .replace(/{{GOAL}}/g, goal);
    } else {
      board = '# Grok Swarm Board — ' + today + '\n\n**Goal:** ' + goal +
        '\n\n## Task Breakdown\n\n<!-- swarm:tasks:start -->\n_(run `swarm board --sync` to fill)_\n<!-- swarm:tasks:end -->\n' +
        '\n## Completed Work Log\n\n<!-- swarm:done:start -->\n_(run `swarm board --sync` to fill)_\n<!-- swarm:done:end -->\n';
    }
    fs.writeFileSync(boardFile, board, 'utf8');
  }

  // agents.json — optional "Label:role" comma list.
  const agentsFile = path.join(root, 'agents.json');
  if (!fs.existsSync(agentsFile)) {
    const agents = [];
    if (args.agents && args.agents !== 'true') {
      for (const spec of String(args.agents).split(',')) {
        const [label, role] = spec.split(':').map((s) => (s || '').trim());
        if (label) agents.push({ label, role: role || 'builder' });
      }
    }
    writeJsonPretty(agentsFile, agents);
  }

  const ws = buildWorkspace(registryRoot, swarmId);
  writeCoordinatorNudge(ws);

  // Seed a primary goal event if a goal was supplied and no events exist.
  const eventsDir = path.join(root, 'plan', 'events');
  const hasEvents = fs.existsSync(eventsDir) && fs.readdirSync(eventsDir).some((f) => f.endsWith('.json'));
  if (args.goal && args.goal !== 'true' && !hasEvents) {
    const now = Date.now();
    const ev = {
      id: genId('evt'),
      type: 'goal_created',
      timestamp: now,
      actorLabel: agentName(),
      goal: { id: 'goal-primary', title: bounded(args.goal, 240), description: bounded(args.goal, 2000), status: 'active' },
    };
    writeJsonPretty(path.join(eventsDir, ev.id + '.json'), ev);
  }

  console.log('Initialized grok-swarm workspace at ' + root);
  console.log('  swarm:      ' + swarmId + '  (select with --swarm ' + swarmId + ' or export SWARM_ID=' + swarmId + ')');
  console.log('  board:      ' + boardFile);
  console.log('  inbox:      ' + path.join(root, 'inbox') + '/');
  console.log('  events:     ' + eventsDir + '/');
  console.log('  dispatches: ' + path.join(root, 'dispatches') + '/');
}

// ---------------------------------------------------------------------------
// swarms — manage multiple swarm instances in one repo
// ---------------------------------------------------------------------------
function swarmStats(ws) {
  const state = readState(ws);
  const tasks = state.tasks.filter((t) => t.status !== 'cancelled');
  const done = tasks.filter((t) => t.status === 'done').length;
  const running = readDispatches(ws).filter((r) => r.status === 'running').length;
  const goal = state.goals[0] || null;
  return {
    tasksDone: done,
    tasksTotal: tasks.length,
    runningDispatches: running,
    paused: !!readPause(ws),
    goalTitle: goal ? goal.title : null,
    goalStatus: goal ? goal.status : null,
  };
}

function swarmsCommand(argv) {
  const args = parseArgs(argv);
  const action = args._[0] || 'list';
  const registryRoot = requireRegistryRoot(args);
  const registry = ensureRegistry(registryRoot);

  if (action === 'list') {
    const rows = registry.swarms.map((s) => ({
      ...s,
      isDefault: registry.default === s.id,
      ...swarmStats(buildWorkspace(registryRoot, s.id)),
    }));
    if (args.json === 'true') {
      console.log(JSON.stringify({ default: registry.default, swarms: rows }, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log('No swarms registered. Run: swarm init <repoPath> --name <slug>');
      return;
    }
    for (const r of rows) {
      const marks = [];
      if (r.isDefault) marks.push('default');
      if (r.paused) marks.push('PAUSED');
      console.log(r.id + (marks.length ? ' [' + marks.join(', ') + ']' : '') +
        '  ' + r.tasksDone + '/' + r.tasksTotal + ' done' +
        (r.runningDispatches ? '  running:' + r.runningDispatches : '') +
        (r.goalTitle ? '  — ' + r.goalTitle : ''));
    }
    return;
  }

  if (action === 'use') {
    const id = args._[1] || (args.id !== 'true' ? args.id : null);
    if (!id) die('Usage: swarm swarms use <id>');
    if (!registry.swarms.some((s) => s.id === id)) die('Unknown swarm "' + id + '" (see: swarm swarms list)');
    registry.default = id;
    writeRegistry(registryRoot, registry);
    console.log('Default swarm set to ' + id);
    return;
  }

  if (action === 'archive') {
    const id = args._[1] || (args.id !== 'true' ? args.id : null);
    if (!id) die('Usage: swarm swarms archive <id>');
    if (!registry.swarms.some((s) => s.id === id)) die('Unknown swarm "' + id + '" (see: swarm swarms list)');
    const src = path.join(registryRoot, 'swarms', id);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(registryRoot, 'archive-' + stamp, id);
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(src, dest);
    }
    registry.swarms = registry.swarms.filter((s) => s.id !== id);
    if (registry.default === id) {
      registry.default = registry.swarms.length === 1 ? registry.swarms[0].id : null;
    }
    writeRegistry(registryRoot, registry);
    console.log('Archived swarm "' + id + '" to ' + dest);
    return;
  }

  die('Usage: swarm swarms list [--json] | swarm swarms use <id> | swarm swarms archive <id>');
}

function migrateCommand(argv) {
  const args = parseArgs(argv);
  const registryRoot = requireRegistryRoot(args);
  const wasLegacy = isLegacyLayout(registryRoot);
  const registry = ensureRegistry(registryRoot); // performs the migration when legacy
  if (!wasLegacy && !readRegistry(registryRoot)) writeRegistry(registryRoot, registry);
  if (args.json === 'true') {
    console.log(JSON.stringify({ migrated: wasLegacy, default: registry.default, swarms: registry.swarms }, null, 2));
    return;
  }
  console.log(wasLegacy
    ? 'Migration complete: legacy state moved to swarms/default.'
    : 'Nothing to migrate — workspace already uses the multi-swarm layout.');
}

// Cross-swarm owned-file overlap report among active tasks (warn-only).
function conflictsCommand(argv) {
  const args = parseArgs(argv);
  const registryRoot = requireRegistryRoot(args);
  const registry = ensureRegistry(registryRoot);

  const owners = []; // { swarmId, taskId, title, file }
  for (const s of registry.swarms) {
    const ws = buildWorkspace(registryRoot, s.id);
    const state = readState(ws);
    for (const t of state.tasks) {
      if (TERMINAL_TASK.has(t.status)) continue;
      for (const f of t.ownedFiles || []) owners.push({ swarmId: s.id, taskId: t.id, title: t.title, file: f });
    }
  }

  const byFile = new Map();
  for (const o of owners) {
    if (!byFile.has(o.file)) byFile.set(o.file, []);
    byFile.get(o.file).push(o);
  }
  const conflicts = [];
  const seenPair = new Set();
  for (const [file, list] of byFile) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.swarmId === b.swarmId) continue; // intra-swarm handled by `swarm check`
        const key = [a.swarmId + '/' + a.taskId, b.swarmId + '/' + b.taskId].sort().join('+');
        let entry = conflicts.find((c) => c.key === key);
        if (!entry) {
          entry = { key, tasks: [a.swarmId + '/' + a.taskId, b.swarmId + '/' + b.taskId].sort(), files: [] };
          conflicts.push(entry);
        }
        if (!entry.files.includes(file)) entry.files.push(file);
        seenPair.add(key);
      }
    }
  }
  const report = conflicts.map(({ tasks, files }) => ({ kind: 'cross-swarm-overlap', tasks, files }));

  if (args.json === 'true') {
    console.log(JSON.stringify({ ok: report.length === 0, conflicts: report }, null, 2));
  } else if (report.length === 0) {
    console.log('OK — no cross-swarm file overlaps among active tasks (' + registry.swarms.length + ' swarms)');
  } else {
    for (const c of report) {
      console.log('[cross-swarm-overlap] ' + c.tasks.join(' + ') + ' share: ' + c.files.join(', '));
    }
  }
  process.exitCode = report.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// mail
// ---------------------------------------------------------------------------
function readMailbox(box) {
  if (!fs.existsSync(box) || !fs.statSync(box).isDirectory()) return [];
  const out = [];
  const files = fs.readdirSync(box).filter((f) => f.endsWith('.json')).sort();
  for (const f of files) {
    const full = path.join(box, f);
    try {
      const m = JSON.parse(fs.readFileSync(full, 'utf8'));
      out.push({ file: full, message: m });
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}

function mailSend(ws, args) {
  const to = args.to;
  const body = bounded(args.body, 8000);
  const type = args.type || 'message';
  if (!to || !body) {
    die('Usage: swarm mail send --to <label|@all> [--type ' + MAIL_TYPES.join('|') + '] --body "..."');
  }
  if (!MAIL_TYPES.includes(type)) die('Invalid message type: ' + type + ' (valid: ' + MAIL_TYPES.join(', ') + ')');

  const id = genId();
  const payload = {
    id,
    from: agentName(),
    to,
    body,
    type,
    timestamp: Date.now(),
  };

  const deliver = (target) => {
    const box = path.join(ws.inbox, target);
    fs.mkdirSync(box, { recursive: true });
    fs.mkdirSync(ws.nudges, { recursive: true });
    writeJsonLine(path.join(box, id + '.json'), payload);
    fs.writeFileSync(path.join(ws.nudges, target + '.txt'), 'Message from ' + payload.from + '\n', 'utf8');
  };

  if (to === '@all') {
    const agents = readAgents(ws).filter((a) => a && a.label && a.label !== payload.from);
    if (agents.length === 0) die('No agents registered in agents.json — cannot broadcast to @all (use: swarm agent register)');
    for (const a of agents) deliver(a.label);
  } else {
    deliver(to);
  }

  fs.mkdirSync(ws.transcript, { recursive: true });
  writeJsonLine(path.join(ws.transcript, id + '.json'), payload);
  console.log('Sent to ' + to);
}

function mailCheck(ws, argv, { peek = false } = {}) {
  const inject = argv.includes('--inject');
  const json = argv.includes('--json');
  const consume = !peek && (inject || argv.includes('--consume'));
  const name = agentName();
  if (name === 'unknown') die('SWARM_AGENT_NAME not set — cannot identify which inbox to read');

  const box = path.join(ws.inbox, name);
  const entries = readMailbox(box);

  if (json) {
    console.log(JSON.stringify(entries.map((e) => e.message), null, 2));
  } else {
    if (inject) console.log('\n--- Grok Swarm Inbox ---');
    if (entries.length === 0) {
      if (inject) console.log('--- End Inbox ---');
      else console.log('No messages');
    } else {
      for (const { message: m } of entries) {
        const from = m.from || 'unknown';
        const type = m.type || 'message';
        if (inject) console.log('From: ' + from + ' | Type: ' + type + ' | Time: ' + (m.timestamp || ''));
        else console.log('From: ' + from + ' | Type: ' + type);
        console.log(m.body || '');
        console.log('');
      }
      if (inject) console.log('--- End Inbox ---');
    }
  }

  if (consume) {
    for (const { file } of entries) fs.rmSync(file, { force: true });
  }
  // peek: exit code signals whether mail exists (0 = mail, 1 = empty) for cheap polling
  if (peek) process.exit(entries.length > 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// event-sourced goals + tasks
// ---------------------------------------------------------------------------
function writeEvent(ws, type, payload) {
  fs.mkdirSync(ws.events, { recursive: true });
  const event = {
    id: genId('evt'),
    type,
    timestamp: Date.now(),
    actorLabel: agentName(),
    ...payload,
  };
  writeJsonPretty(path.join(ws.events, event.id + '.json'), event);
  return event;
}

function readEvents(ws) {
  try {
    return fs.readdirSync(ws.events)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => {
        try { return JSON.parse(fs.readFileSync(path.join(ws.events, f), 'utf8')); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function applyEvent(state, event) {
  if (!event || typeof event !== 'object') return state;
  const now = Number.isFinite(event.timestamp) ? event.timestamp : Date.now();
  const actor = typeof event.actorLabel === 'string' ? event.actorLabel : 'unknown';

  if ((event.type === 'goal_created' || event.type === 'goal_updated') && event.goal && event.goal.id) {
    const existing = state.goals.find((g) => g.id === event.goal.id);
    const next = {
      id: event.goal.id,
      title: bounded(event.goal.title, 240) || (existing && existing.title) || 'Untitled goal',
      description: bounded(event.goal.description, 2000) || (existing && existing.description),
      status: GOAL_STATUSES.has(event.goal.status) ? event.goal.status : ((existing && existing.status) || 'active'),
      createdAt: (existing && existing.createdAt) || now,
      updatedAt: now,
      createdBy: (existing && existing.createdBy) || actor,
      updatedBy: actor,
    };
    state.goals = existing ? state.goals.map((g) => (g.id === next.id ? next : g)) : [...state.goals, next];
    return state;
  }

  if ((event.type === 'task_created' || event.type === 'task_updated') && event.task && event.task.id) {
    const existing = state.tasks.find((t) => t.id === event.task.id);
    const status = TASK_STATUSES.has(event.task.status)
      ? event.task.status
      : ((existing && existing.status) || (event.task.ownerAgentLabel ? 'assigned' : 'open'));
    const next = {
      id: event.task.id,
      goalId: event.task.goalId || (existing && existing.goalId) || (state.goals[0] && state.goals[0].id) || 'goal-primary',
      title: bounded(event.task.title, 240) || (existing && existing.title) || 'Untitled task',
      description: bounded(event.task.description, 2000) || (existing && existing.description),
      status,
      ownerAgentLabel: bounded(event.task.ownerAgentLabel, 160) || (existing && existing.ownerAgentLabel),
      ownedFiles: Array.isArray(event.task.ownedFiles) ? event.task.ownedFiles : ((existing && existing.ownedFiles) || []),
      acceptanceCriteria: Array.isArray(event.task.acceptanceCriteria) ? event.task.acceptanceCriteria : ((existing && existing.acceptanceCriteria) || []),
      dependsOn: Array.isArray(event.task.dependsOn) ? event.task.dependsOn : ((existing && existing.dependsOn) || []),
      notes: (existing && existing.notes) || [],
      blockedReason: bounded(event.task.blockedReason, 1000) || (status === 'blocked' && existing ? existing.blockedReason : undefined),
      createdAt: (existing && existing.createdAt) || now,
      updatedAt: now,
      completedAt: status === 'done' ? (event.task.completedAt || (existing && existing.completedAt) || now) : (existing && existing.completedAt),
      createdBy: (existing && existing.createdBy) || actor,
      updatedBy: actor,
    };
    state.tasks = existing ? state.tasks.map((t) => (t.id === next.id ? next : t)) : [...state.tasks, next];
    return state;
  }

  if (event.type === 'task_note_added' && event.taskId && event.note && event.note.text) {
    state.tasks = state.tasks.map((t) => {
      if (t.id !== event.taskId) return t;
      const note = {
        id: event.note.id || event.id,
        agentLabel: bounded(event.note.agentLabel, 160) || actor,
        text: bounded(event.note.text, 1000) || '',
        timestamp: Number.isFinite(event.note.timestamp) ? event.note.timestamp : now,
      };
      return { ...t, notes: [...t.notes, note].slice(-20), updatedAt: now, updatedBy: actor };
    });
  }
  return state;
}

function readState(ws) {
  return readEvents(ws).reduce(applyEvent, { goals: [], tasks: [] });
}

function resolveGoalId(input, state) {
  if (!input || input === 'primary' || input === 'true') {
    return (state.goals[0] && state.goals[0].id) || 'goal-primary';
  }
  return input;
}

// ---------------------------------------------------------------------------
// validation — overlaps, deps
// ---------------------------------------------------------------------------
function findOverlaps(tasks, candidateFiles, excludeId) {
  const overlaps = [];
  const candidate = new Set(candidateFiles);
  for (const t of tasks) {
    if (t.id === excludeId) continue;
    if (TERMINAL_TASK.has(t.status)) continue;
    const shared = (t.ownedFiles || []).filter((f) => candidate.has(f));
    if (shared.length > 0) overlaps.push({ taskId: t.id, title: t.title, files: shared });
  }
  return overlaps;
}

function depsAllDone(task, byId) {
  for (const dep of task.dependsOn || []) {
    const d = byId.get(dep);
    if (!d || d.status !== 'done') return false;
  }
  return true;
}

/** Shared owned files between two tasks (order preserved from a). */
function sharedOwnedFiles(a, b) {
  const bFiles = new Set(b.ownedFiles || []);
  return (a.ownedFiles || []).filter((f) => bFiles.has(f));
}

/** Intersection of ownedFiles across all tasks. */
function ownedFilesIntersection(tasks) {
  if (!tasks.length) return [];
  let set = new Set(tasks[0].ownedFiles || []);
  for (let i = 1; i < tasks.length; i++) {
    const next = new Set(tasks[i].ownedFiles || []);
    set = new Set([...set].filter((f) => next.has(f)));
  }
  return [...set];
}

/**
 * Detect serial "hot-hub" chains: 3+ non-terminal tasks linked by depends_on where
 * consecutive tasks share files AND the whole chain still shares a hub core
 * (≥ SERIAL_HUB_CORE_MIN files). That is the anti-pattern that turns a swarm into
 * one builder at a time (phase monoliths leasing tools.ts + mutations + locales…).
 *
 * Fix shape: domain packs on NEW disjoint files in parallel, then ONE wire task
 * that alone owns the shared hub. See docs/2026-08-07-hot-hub-adjudication.md.
 */
const SERIAL_HUB_CORE_MIN = 3;
const SERIAL_HUB_CHAIN_MIN_TASKS = 3;

function findSerialHubChains(active) {
  const byId = new Map(active.map((t) => [t.id, t]));
  const chains = []; // { tasks: id[], files: string[] }

  function walk(pathIds) {
    if (pathIds.length >= SERIAL_HUB_CHAIN_MIN_TASKS) {
      const nodes = pathIds.map((id) => byId.get(id)).filter(Boolean);
      const hub = ownedFilesIntersection(nodes);
      if (hub.length >= SERIAL_HUB_CORE_MIN) {
        chains.push({ tasks: pathIds.slice(), files: hub });
      }
    }
    const last = byId.get(pathIds[pathIds.length - 1]);
    if (!last) return;
    for (const t of active) {
      if (pathIds.includes(t.id)) continue;
      if (!(t.dependsOn || []).includes(last.id)) continue;
      // Only follow depends that exist because of shared file leases
      if (sharedOwnedFiles(last, t).length === 0) continue;
      walk(pathIds.concat(t.id));
    }
  }

  for (const t of active) walk([t.id]);

  // Keep maximal chains only (drop paths that are strict subsets of a longer chain)
  const maximal = chains.filter((c, i) => {
    const key = c.tasks.join('\0');
    return !chains.some((other, j) => {
      if (i === j) return false;
      if (other.tasks.length <= c.tasks.length) return false;
      const o = other.tasks.join('\0');
      return o.includes(key) || other.tasks.join(',').includes(c.tasks.join(','));
    });
  });

  // Prefer simple subset check on task-id sets
  const byKey = new Map();
  for (const c of maximal.length ? maximal : chains) {
    const key = c.tasks.join('|');
    if (!byKey.has(key)) byKey.set(key, c);
  }
  // Drop chain A if some chain B's task list is a strict supersequence containing A as contiguous subpath
  const list = [...byKey.values()];
  return list.filter((c) => {
    const cStr = '|' + c.tasks.join('|') + '|';
    return !list.some((other) => {
      if (other.tasks.length <= c.tasks.length) return false;
      const oStr = '|' + other.tasks.join('|') + '|';
      return oStr.includes(cStr);
    });
  });
}

/** True if `fromId` can reach `toId` by following dependsOn edges (transitive). */
function dependsReaches(byId, fromId, toId, seen = new Set()) {
  if (fromId === toId) return true;
  if (seen.has(fromId)) return false;
  seen.add(fromId);
  const t = byId.get(fromId);
  if (!t) return false;
  for (const dep of t.dependsOn || []) {
    if (dependsReaches(byId, dep, toId, seen)) return true;
  }
  return false;
}

/** Tasks that share files are "sequenced" if either depends on the other (direct or transitive). */
function tasksSequencedByDepends(byId, a, b) {
  return dependsReaches(byId, a.id, b.id) || dependsReaches(byId, b.id, a.id);
}

// Pure board validation — same problems shape as `swarm check --json`.
function validateBoard(state, opts = {}) {
  const byId = new Map(state.tasks.map((t) => [t.id, t]));
  const problems = [];
  const allowSerialHub = opts.allowSerialHub === true;

  // 1. File overlaps among non-terminal tasks
  const active = state.tasks.filter((t) => !TERMINAL_TASK.has(t.status));
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i], b = active[j];
      const bFiles = new Set(b.ownedFiles || []);
      const shared = (a.ownedFiles || []).filter((f) => bFiles.has(f));
      if (shared.length > 0) {
        // Transitive depends counts: A→B→C sharing hub is sequenced for overlap purposes
        // (serial_hub_chain is the dedicated anti-pattern for that shape).
        const sequenced = tasksSequencedByDepends(byId, a, b);
        if (!sequenced) {
          problems.push({ kind: 'overlap', tasks: [a.id, b.id], files: shared, message: a.id + ' and ' + b.id + ' share files without a depends-on: ' + shared.join(', ') });
        }
      }
    }
  }

  // 2. Missing dependency references
  for (const t of state.tasks) {
    for (const dep of t.dependsOn || []) {
      if (!byId.has(dep)) problems.push({ kind: 'missing_dep', tasks: [t.id], message: t.id + ' depends on unknown task ' + dep });
    }
  }

  // 3. Dependency cycles (DFS)
  const visiting = new Set(), visited = new Set();
  const dfs = (id, stack) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      problems.push({ kind: 'cycle', tasks: [...stack, id], message: 'Dependency cycle: ' + [...stack, id].join(' -> ') });
      return;
    }
    visiting.add(id);
    const t = byId.get(id);
    for (const dep of (t && t.dependsOn) || []) dfs(dep, [...stack, id]);
    visiting.delete(id);
    visited.add(id);
  };
  for (const t of state.tasks) dfs(t.id, []);

  // 4. Serial hot-hub chains (phase monoliths leasing the same hub under --depends)
  if (!allowSerialHub) {
    for (const chain of findSerialHubChains(active)) {
      const hubPreview = chain.files.slice(0, 8).join(', ') + (chain.files.length > 8 ? ', …' : '');
      problems.push({
        kind: 'serial_hub_chain',
        tasks: chain.tasks,
        files: chain.files,
        message:
          'Serial hot-hub chain (' + chain.tasks.length + ' tasks share ' + chain.files.length +
          ' hub files via depends_on): ' + chain.tasks.join(' → ') +
          '. Hub core: ' + hubPreview +
          '. This yields one builder at a time. Fix: domain packs on NEW disjoint files in parallel, then ONE wire task owning the hub. See docs/2026-08-07-hot-hub-adjudication.md. Escape hatch: swarm check --allow-serial-hub',
      });
    }
  }

  return { ok: problems.length === 0, problems };
}

function checkCommand(ws, argv) {
  const args = parseArgs(argv);
  const state = readState(ws);
  const allowSerialHub = args['allow-serial-hub'] === true || args['allow-serial-hub'] === 'true';
  const { problems } = validateBoard(state, { allowSerialHub });

  if (args.json === 'true') {
    console.log(JSON.stringify({ ok: problems.length === 0, problems, allowSerialHub }, null, 2));
  } else if (problems.length === 0) {
    console.log('OK — no overlaps, missing deps, cycles, or serial hub chains (' + state.tasks.length + ' tasks)');
  } else {
    for (const p of problems) console.log('[' + p.kind + '] ' + p.message);
  }
  process.exit(problems.length === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// goal / task commands
// ---------------------------------------------------------------------------
function goalCommand(ws, action, argv) {
  const args = parseArgs(argv);
  const state = readState(ws);
  if (action === 'create') {
    const ev = writeEvent(ws, 'goal_created', {
      goal: {
        id: bounded(args.id, 200) || 'goal-primary',
        title: requiredString(args.title, 240, 'title'),
        description: bounded(args.description, 2000),
        status: GOAL_STATUSES.has(args.status) ? args.status : 'active',
      },
    });
    console.log('Created goal ' + ev.goal.id + ': ' + ev.goal.title);
    return;
  }
  if (action === 'update') {
    const id = resolveGoalId(args.id, state);
    if (!state.goals.find((g) => g.id === id)) die('Unknown goal id: ' + id);
    if (args.status && !GOAL_STATUSES.has(args.status)) die('Invalid goal status: ' + args.status);
    const ev = writeEvent(ws, 'goal_updated', {
      goal: { id, title: bounded(args.title, 240), description: bounded(args.description, 2000), status: args.status },
    });
    console.log('Updated goal ' + ev.goal.id);

    // Auto-cleanup after goal completion when the board is fully terminal
    // (all tasks done/cancelled). Standalone only — mega sub-swarms use mega cleanup.
    // Prevents leftover worktrees after mission end (omni-phases-2-6 2026-08-07).
    // Opt out: --no-cleanup or GROK_SWARM_AUTO_CLEANUP=0.
    if (
      args.status === 'completed' &&
      args['no-cleanup'] !== 'true' &&
      process.env.GROK_SWARM_AUTO_CLEANUP !== '0'
    ) {
      const after = readState(ws);
      const tasks = after.tasks || [];
      const unfinished = tasks.filter((t) => !TERMINAL_TASK.has(String(t.status || '')));
      const megaCtx = path.join(ws.root, 'mega-context.json');
      // Board mirror goes stale at archive time if the coordinator forgot the final
      // --sync (autolabs 2026-08-13: reviewer showed BUILDING in the archived board
      // although its double-check said complete). Sync mechanically before cleanup.
      try {
        execFileSync(process.execPath, [__filename, 'board', '--sync'], {
          cwd: ws.repoRoot || process.cwd(),
          env: { ...process.env, SWARM_AGENT_NAME: process.env.SWARM_AGENT_NAME || 'Coordinator', SWARM_ID: ws.swarmId || '' },
          encoding: 'utf8',
          stdio: 'ignore',
          timeout: 30000,
        });
      } catch { /* board sync is best-effort; never blocks completion */ }
      // Unpushed work is the #1 silent gap at mission end (autolabs 2026-08-13:
      // both swarms finished 12+ commits ahead of origin with push required by the
      // goal). Warn loudly; the coordinator prompt makes pushing part of merge flow.
      if (ws.repoRoot) {
        try {
          const ahead = execFileSync('git', ['rev-list', '--count', '@{upstream}..HEAD'], {
            cwd: ws.repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000,
          }).trim();
          if (Number(ahead) > 0) {
            console.log(
              'WARNING: ' + ahead + ' commit(s) not pushed to upstream. If the goal requires pushing, run `git push` from ' +
                ws.repoRoot + ' and re-check before reporting the mission complete (never --no-verify; if a pre-push hook fails, follow its instructions).',
            );
          }
        } catch { /* no upstream configured — nothing to warn about */ }
      }
      if (fs.existsSync(megaCtx)) {
        console.log(
          'Goal completed (mega sub-swarm) — skipping auto cleanup. Meta runs: swarm mega cleanup --full',
        );
      } else if (tasks.length === 0) {
        // Vacuous "all done" — do not archive empty/init-only boards (test + early goals).
        console.log('Goal completed with zero tasks — skipping auto cleanup.');
      } else if (unfinished.length > 0) {
        console.log(
          'Goal completed but ' +
            unfinished.length +
            ' task(s) still open — skipping auto cleanup until the board is fully terminal.',
        );
      } else if (ws.swarmId && ws.repoRoot) {
        console.log(
          'Goal completed — auto cleanup: worktrees + tied swarm/wt-* branches for swarm "' +
            ws.swarmId +
            '" (disable: --no-cleanup or GROK_SWARM_AUTO_CLEANUP=0)',
        );
        try {
          execFileSync(
            process.execPath,
            [__filename, 'cleanup', '--swarm', ws.swarmId, '--repo', ws.repoRoot],
            {
              cwd: ws.repoRoot,
              env: {
                ...process.env,
                SWARM_AGENT_NAME: process.env.SWARM_AGENT_NAME || 'Coordinator',
                SWARM_ID: ws.swarmId,
              },
              encoding: 'utf8',
              stdio: 'inherit',
              timeout: 120000,
            },
          );
        } catch (err) {
          console.error(
            'warn: auto cleanup after goal complete failed: ' +
              String((err && err.message) || err) +
              '\n  Run manually: swarm cleanup --swarm ' +
              ws.swarmId +
              ' --repo ' +
              ws.repoRoot,
          );
        }
      }
    }
    return;
  }
  die(
    'Usage: swarm goal create|update --title "..." [--status active|completed|blocked|cancelled] [--no-cleanup]',
  );
}

function taskCommand(ws, action, argv) {
  const args = parseArgs(argv);
  const state = readState(ws);
  if (action === 'create') {
    if (args.status && !TASK_STATUSES.has(args.status)) die('Invalid task status: ' + args.status);
    const owner = bounded(args.owner, 160);
    const files = list(args.files, 40, 500);
    const depends = list(args.depends, 50, 200);

    // Overlap guard: shared files require depends-on (direct or transitive via the depends list) or --force.
    // Example: C --depends B, B --depends A, C shares hub with A → allowed (sequenced chain); swarm check
    // may still flag serial_hub_chain if the chain is a phase-monolith hub lease.
    if (files.length > 0 && args.force !== 'true') {
      const byId = new Map(state.tasks.map((t) => [t.id, t]));
      const overlaps = findOverlaps(state.tasks, files, null).filter((o) => {
        if (depends.includes(o.taskId)) return false;
        // Transitive: any listed depend eventually depends on the overlapping task
        return !depends.some((d) => dependsReaches(byId, d, o.taskId));
      });
      if (overlaps.length > 0) {
        for (const o of overlaps) {
          console.error('File overlap with ' + o.taskId + ' (' + o.title + '): ' + o.files.join(', '));
        }
        die('Refusing to create: owned files overlap an active task. Add --depends ' + overlaps.map((o) => o.taskId).join(',') + ' to sequence, or --force to override.');
      }
    }

    const ev = writeEvent(ws, 'task_created', {
      task: {
        id: bounded(args.id, 200) || genId('task'),
        goalId: resolveGoalId(args.goal, state),
        title: requiredString(args.title, 240, 'title'),
        description: bounded(args.description, 2000),
        status: args.status || (owner ? 'assigned' : 'open'),
        ownerAgentLabel: owner,
        ownedFiles: files,
        acceptanceCriteria: list(args.acceptance, 20, 500),
        dependsOn: depends,
      },
    });
    console.log('Created task ' + ev.task.id + ': ' + ev.task.title);
    return;
  }
  if (action === 'update') {
    const id = requiredString(args.id, 200, 'id');
    if (!state.tasks.find((t) => t.id === id)) die('Unknown task id: ' + id);
    if (args.status && !TASK_STATUSES.has(args.status)) die('Invalid task status: ' + args.status);
    if (args.note) {
      const ev = writeEvent(ws, 'task_note_added', {
        taskId: id,
        note: { id: genId('note'), agentLabel: agentName(), text: requiredString(args.note, 1000, 'note'), timestamp: Date.now() },
      });
      console.log('Added note to task ' + ev.taskId);
    }
    const patch = {
      id,
      title: bounded(args.title, 240),
      description: bounded(args.description, 2000),
      status: args.status,
      ownerAgentLabel: bounded(args.owner, 160),
      blockedReason: bounded(args.blockedReason || args.blocked, 1000),
    };
    if (args.files) {
      const files = list(args.files, 40, 500);
      if (files.length > 0 && args.force !== 'true') {
        const task = state.tasks.find((t) => t.id === id);
        const depends = args.depends
          ? list(args.depends, 50, 200)
          : ((task && task.dependsOn) || []);
        const byId = new Map(state.tasks.map((t) => [t.id, t]));
        const overlaps = findOverlaps(state.tasks, files, id).filter((o) => {
          if (depends.includes(o.taskId)) return false;
          return !depends.some((d) => dependsReaches(byId, d, o.taskId));
        });
        if (overlaps.length > 0) {
          for (const o of overlaps) console.error('File overlap with ' + o.taskId + ': ' + o.files.join(', '));
          die('Refusing to update: owned files overlap an active task. Sequence with --depends or use --force.');
        }
      }
      patch.ownedFiles = files;
    }
    if (args.acceptance) patch.acceptanceCriteria = list(args.acceptance, 20, 500);
    if (args.depends) patch.dependsOn = list(args.depends, 50, 200);
    const meaningful = Object.keys(patch).some((k) => k !== 'id' && patch[k] !== undefined);
    if (meaningful) {
      const ev = writeEvent(ws, 'task_updated', { task: patch });
      console.log('Updated task ' + ev.task.id);
    } else if (!args.note) {
      die('No task update provided');
    }
    return;
  }
  if (action === 'list') {
    const tasks = state.tasks
      .filter((t) => !args.goal || t.goalId === resolveGoalId(args.goal, state))
      .filter((t) => !args.owner || t.ownerAgentLabel === args.owner)
      .filter((t) => !args.status || t.status === args.status);
    if (args.json === 'true') {
      console.log(JSON.stringify(tasks, null, 2));
      return;
    }
    if (tasks.length === 0) {
      console.log('No tasks');
      return;
    }
    for (const t of tasks) {
      const owner = t.ownerAgentLabel ? ' @' + t.ownerAgentLabel : '';
      console.log(t.id + ' [' + t.status + ']' + owner + ' ' + t.title);
    }
    return;
  }
  if (action === 'ready') {
    const paused = readPause(ws);
    if (paused && args.json !== 'true') {
      console.log('NOTE: swarm is PAUSED (since ' + new Date(paused.pausedAt).toISOString() + ') — run `swarm resume` before dispatching.');
    }
    const byId = new Map(state.tasks.map((t) => [t.id, t]));
    const ready = state.tasks.filter((t) =>
      (t.status === 'open' || t.status === 'assigned') && depsAllDone(t, byId));
    if (args.json === 'true') {
      console.log(JSON.stringify(ready, null, 2));
      return;
    }
    if (ready.length === 0) {
      console.log('No dispatchable tasks (open/assigned with all deps done)');
      return;
    }
    for (const t of ready) {
      const owner = t.ownerAgentLabel ? ' @' + t.ownerAgentLabel : ' (unassigned)';
      console.log(t.id + owner + ' ' + t.title);
      if (t.ownedFiles && t.ownedFiles.length) console.log('  files: ' + t.ownedFiles.join(', '));
    }
    return;
  }
  die('Usage: swarm task create|update|list|ready ...');
}

// ---------------------------------------------------------------------------
// agents
// ---------------------------------------------------------------------------
function agentCommand(ws, action, argv) {
  const args = parseArgs(argv);
  if (action === 'register') {
    const label = requiredString(args.label, 160, 'label');
    const role = bounded(args.role, 60) || 'builder';
    const allowed = new Set(['coordinator', 'builder', 'reviewer', 'scout', 'logger']);
    if (!allowed.has(role)) {
      die('Invalid --role "' + role + '" (use coordinator|builder|reviewer|scout|logger)');
    }
    const agents = readAgents(ws);
    const existing = agents.find((a) => a && a.label === label);
    if (existing) {
      existing.role = role;
    } else {
      agents.push({ label, role });
    }
    writeJsonPretty(ws.agentsFile, agents);
    console.log((existing ? 'Updated' : 'Registered') + ' agent ' + label + ' (' + role + ')');
    return;
  }
  if (action === 'list') {
    const agents = readAgents(ws);
    if (args.json === 'true') {
      console.log(JSON.stringify(agents, null, 2));
      return;
    }
    if (agents.length === 0) {
      console.log('No agents registered');
      return;
    }
    for (const a of agents) console.log(a.label + ' (' + (a.role || 'builder') + ')');
    return;
  }
  die('Usage: swarm agent register --label "Builder 3" [--role coordinator|builder|reviewer|scout|logger] | swarm agent list [--json]');
}

// ---------------------------------------------------------------------------
// worktree path resolution for resume commands
// ---------------------------------------------------------------------------
function shellQuote(s) {
  if (!s) return '""';
  if (/^[A-Za-z0-9_./-]+$/.test(s)) return s;
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function resolveWorktreePath(i) {
  if (i.worktreePath) return i.worktreePath;
  if (!i.worktree) return null;
  try {
    const { execSync } = require('child_process');
    const out = execSync('grok worktree list --json', { encoding: 'utf8', timeout: 15000 });
    const list = JSON.parse(out);
    if (Array.isArray(list)) {
      const found = list.find((w) => w && (w.name === i.worktree || w.id === i.worktree));
      if (found && found.path) return found.path;
    }
  } catch {
    /* grok missing or JSON parse failure — caller falls back to placeholder */
  }
  return null;
}

function buildResumeGrokCommand(i, title) {
  const agent = i.agentLabel || 'Builder';
  const safeTitle = title.replace(/"/g, '\\"');
  const resumePrompt = 'Resume your paused swarm task (' + safeTitle +
    '). Re-read your original instructions in this session, check current file state, and continue to completion.';
  const wtPath = resolveWorktreePath(i);
  const wtArg = wtPath ? shellQuote(wtPath) : (i.worktree ? '<worktree path — see grok worktree list>' : null);

  if (i.sessionId) {
    // Write a small resume prompt under the swarm prompts dir (or /tmp fallback)
    let promptFile = null;
    try {
      const promptsDir = i.repoRoot
        ? path.join(i.repoRoot, '.grok-swarm', 'prompts')
        : path.join(process.env.HOME || '/tmp', '.grok-swarm-prompts');
      fs.mkdirSync(promptsDir, { recursive: true });
      const slug = String(i.id || i.dispatchId || 'resume').replace(/[^a-zA-Z0-9._-]/g, '_');
      promptFile = path.join(promptsDir, 'resume-' + slug + '.md');
      fs.writeFileSync(promptFile, resumePrompt + '\n', 'utf8');
    } catch {
      promptFile = path.join(
        process.env.TMPDIR || '/tmp',
        'grok-swarm-resume-' + String(i.sessionId).slice(0, 12) + '.md',
      );
      try {
        fs.writeFileSync(promptFile, resumePrompt + '\n', 'utf8');
      } catch {
        promptFile = null;
      }
    }
    if (promptFile) {
      const maxTurns = Number(process.env.GROK_SWARM_WORKER_MAX_TURNS) || 100;
      return buildWorkerResumeCommand({
        agentLabel: agent,
        sessionId: i.sessionId,
        worktreePath: wtPath || null,
        promptFile,
        model: workerModel(),
        effort: 'medium',
        maxTurns,
      });
    }
    // Fallback if prompt file write failed
    const cwdPart = wtArg ? ' --cwd ' + wtArg : '';
    return 'SWARM_AGENT_NAME="' + agent + '" grok -p "' + resumePrompt + '" -r ' + i.sessionId + cwdPart +
      ' -m ' + workerModel() + ' --always-approve --no-subagents --max-turns 100';
  }
  if (wtArg) {
    return 'SWARM_AGENT_NAME="' + agent + '" grok -c -p "' + resumePrompt +
      '" --cwd ' + wtArg + ' -m ' + workerModel() + ' --always-approve';
  }
  return '# No sessionId or worktree recorded — redispatch Mode B from the original prompt file and record a new dispatch';
}

// ---------------------------------------------------------------------------
// dispatch records — one JSON file per builder/reviewer grok run
// ---------------------------------------------------------------------------
function readDispatches(ws) {
  if (!fs.existsSync(ws.dispatches)) return [];
  return fs.readdirSync(ws.dispatches)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(ws.dispatches, f), 'utf8')); } catch { return null; }
    })
    .filter(Boolean);
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Auto-heal dispatch records left as `running` after the process exited.
 * Incident (2026-07-14 mega-fe): coordinator never called dispatch update →
 * dashboard/watch showed "Builder 1 · 26m (exited?)" for a finished builder.
 *
 * Called from dashboardState / dispatch list / dispatch reconcile so the board
 * self-heals even when the Grok coordinator forgets.
 *
 * Does NOT change task status — only dispatch status. Coordinator still owns
 * gates, visual, merge.
 *
 * @returns {{ id, from, to, reason }[]}
 */
function reconcileDeadDispatches(ws, opts) {
  const options = opts || {};
  const dryRun = options.dryRun === true;
  // Quiet window before declaring failed when PID is dead but log has no end
  // (flush race). End-event path does not wait.
  const quietMs = Number.isFinite(options.quietMs) ? options.quietMs : 10_000;
  const now = Date.now();
  const changes = [];

  for (const rec of readDispatches(ws)) {
    if (rec.status !== 'running') continue;

    const alive = isPidAlive(rec.pid);
    // No PID recorded: only reconcile when log clearly ended (can't probe process).
    if (alive === true) continue;
    if (alive === null && !(rec.logFile)) continue;

    const log = analyzeDispatchLog(rec.logFile);
    if (alive === null && !(log.hasEnd || log.hasError)) continue;

    // Log still being written and no terminal event yet — wait.
    if (!log.hasEnd && !log.hasError && log.logMtime && now - log.logMtime < quietMs) {
      continue;
    }

    let toStatus;
    let exitCode;
    let reason;
    if (log.hasEnd && !log.hasError) {
      toStatus = 'done';
      exitCode = 0;
      reason = 'auto-reconcile: PID dead + log end event';
    } else if (log.hasError) {
      toStatus = 'failed';
      exitCode = 1;
      reason = 'auto-reconcile: PID dead + log error event';
    } else if (alive === false) {
      toStatus = 'failed';
      exitCode = 1;
      reason = 'auto-reconcile: PID dead, no log end (quiet ≥' + Math.round(quietMs / 1000) + 's)';
    } else {
      continue;
    }

    changes.push({
      id: rec.id,
      from: 'running',
      to: toStatus,
      reason,
      taskId: rec.taskId,
      agentLabel: rec.agentLabel,
      pid: rec.pid,
    });

    if (dryRun) continue;

    rec.status = toStatus;
    rec.exitCode = exitCode;
    rec.updatedAt = now;
    rec.reconciledAt = now;
    rec.reconcileReason = reason;
    if (log.sessionId && !rec.sessionId) rec.sessionId = log.sessionId;
    if (log.totalCostUsd != null) rec.totalCostUsd = log.totalCostUsd;
    if (log.numTurns != null) rec.numTurns = log.numTurns;
    if (log.usage) rec.usage = log.usage;
    if (log.stopReason) rec.stopReason = log.stopReason;
    const prevNote = rec.note ? String(rec.note) + ' | ' : '';
    rec.note = bounded(prevNote + reason, 1000);
    writeJsonPretty(path.join(ws.dispatches, rec.id + '.json'), rec);
  }

  return changes;
}

/**
 * Dashboard lag fix (2026-07-30): tasks stay `assigned` → UI says "Queued for X"
 * until the coordinator remembers `task update --status building`. Promote
 * immediately when a running dispatch is recorded so the board/dashboard track
 * live builders without waiting on the LLM coordinator loop.
 *
 * Only promotes open|assigned|planning → building. Never demotes review/done/blocked.
 * @returns {boolean} true if a status event was written
 */
function promoteTaskBuildingOnDispatch(ws, taskId, meta) {
  if (!taskId) return false;
  let state;
  try {
    state = readState(ws);
  } catch {
    return false;
  }
  const task = (state.tasks || []).find((t) => t.id === taskId);
  if (!task) return false;
  const st = String(task.status || '');
  if (st !== 'open' && st !== 'assigned' && st !== 'planning') return false;

  const noteBits = [];
  if (meta && meta.agentLabel) noteBits.push(String(meta.agentLabel));
  if (meta && meta.worktree) noteBits.push('wt=' + meta.worktree);
  if (meta && meta.worktreePath) noteBits.push('path=' + meta.worktreePath);
  if (meta && meta.pid) noteBits.push('pid=' + meta.pid);
  const noteText =
    'auto-building: dispatch recorded' + (noteBits.length ? ' (' + noteBits.join(' ') + ')' : '');

  writeEvent(ws, 'task_updated', {
    task: {
      id: taskId,
      status: 'building',
      ownerAgentLabel: (meta && meta.agentLabel) || task.ownerAgentLabel,
    },
  });
  writeEvent(ws, 'task_note_added', {
    taskId,
    note: {
      id: genId('note'),
      agentLabel: agentName() || 'system',
      text: bounded(noteText, 1000),
      timestamp: Date.now(),
    },
  });
  return true;
}

/**
 * Optional post-record sanity: grok worktree list + B1 MAIN checkout check.
 * Non-fatal warnings only (preserves existing --verify-worktree contract).
 */
function verifyDispatchWorktree(ws, rec, args, isolation) {
  if (args['verify-worktree'] !== 'true') return;

  // B1: if worktree-path points at MAIN, CRITICAL warn (do not die — tests expect non-fatal)
  if (rec.worktreePath && isolation && typeof isolation.assertWorktreeNotMain === 'function') {
    const mainRoot = ws.repoRoot || null;
    if (mainRoot) {
      const check = isolation.assertWorktreeNotMain(rec.worktreePath, mainRoot);
      if (!check.ok) {
        const reason = check.reason || 'worktree path is MAIN checkout';
        console.log(/CRITICAL/i.test(reason) ? reason : 'CRITICAL: ' + reason);
        console.log(
          '  worktreePath=' +
            rec.worktreePath +
            ' main=' +
            mainRoot +
            ' — do not merge; redispatch Mode A/B with isolated worktree.',
        );
      }
    }
  }

  if (!rec.worktree) {
    console.log('WARNING: --verify-worktree passed but no --worktree name recorded; skipping check.');
    return;
  }
  try {
    const { execSync } = require('child_process');
    const out = execSync('grok worktree list', { encoding: 'utf8', timeout: 15000 });
    if (!out.includes(rec.worktree)) {
      console.log('WARNING: worktree "' + rec.worktree + '" not found in `grok worktree list`.');
      console.log('  The builder may be running in the MAIN REPO (resume flags ignore --worktree).');
      console.log('  Verify the log file and consider `swarm dispatch update --id ' + rec.id + ' --status failed`.');
    } else {
      console.log('Verified: worktree "' + rec.worktree + '" exists.');
    }
  } catch (err) {
    console.log(
      'WARNING: could not verify worktree (`grok worktree list` failed): ' +
        (err && err.message ? err.message.split('\n')[0] : err),
    );
  }
}

function dispatchCommand(ws, action, argv) {
  const args = parseArgs(argv);
  fs.mkdirSync(ws.dispatches, { recursive: true });

  if (action === 'record') {
    const isolation = require('./isolation-guard.cjs');
    const paused = readPause(ws);
    if (paused && args.force !== 'true') {
      die('Swarm is paused (since ' + new Date(paused.pausedAt).toISOString() + '). Run `swarm resume` first, or pass --force.');
    }
    const rec = {
      id: genId('run'),
      taskId: bounded(args.task, 200),
      agentLabel: bounded(args.agent, 160) || agentName(),
      worktree: bounded(args.worktree, 200),
      worktreePath: bounded(args['worktree-path'], 500),
      logFile: bounded(args.log, 500),
      pid: args.pid && args.pid !== 'true' ? Number(args.pid) : undefined,
      sessionId: bounded(args.session, 200),
      baseRef: bounded(args.base, 200),
      status: DISPATCH_STATUSES.has(args.status) ? args.status : 'running',
      note: bounded(args.note, 1000),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      recordedBy: agentName(),
    };
    if (!rec.taskId) die('Missing required --task <taskId>');

    // A5: same taskId+pid already running → update existing, do not create duplicate
    if (rec.status === 'running' && isolation.finitePid(rec.pid) != null) {
      const existing = isolation.findRunningDuplicate(readDispatches(ws), rec.taskId, rec.pid);
      if (existing) {
        if (rec.agentLabel) existing.agentLabel = rec.agentLabel;
        if (rec.worktree) existing.worktree = rec.worktree;
        if (rec.worktreePath) existing.worktreePath = rec.worktreePath;
        if (rec.logFile) existing.logFile = rec.logFile;
        if (rec.sessionId) existing.sessionId = rec.sessionId;
        if (rec.baseRef) existing.baseRef = rec.baseRef;
        if (rec.note) {
          const prev = existing.note ? String(existing.note) + ' | ' : '';
          existing.note = bounded(prev + rec.note, 1000);
        }
        existing.pid = rec.pid;
        existing.status = 'running';
        existing.updatedAt = Date.now();
        existing.recordedBy = rec.recordedBy;
        const dedupeNote = 'dedupe A5: re-record same taskId+pid';
        const prevNote = existing.note ? String(existing.note) + ' | ' : '';
        if (!String(existing.note || '').includes('dedupe A5')) {
          existing.note = bounded(prevNote + dedupeNote, 1000);
        }
        writeJsonPretty(path.join(ws.dispatches, existing.id + '.json'), existing);
        console.log(
          'Updated existing dispatch ' +
            existing.id +
            ' (dedupe A5: task ' +
            existing.taskId +
            ', pid ' +
            existing.pid +
            ', agent ' +
            (existing.agentLabel || '—') +
            ')',
        );
        if (existing.status === 'running') {
          const promoted = promoteTaskBuildingOnDispatch(ws, existing.taskId, {
            agentLabel: existing.agentLabel,
            worktree: existing.worktree,
            worktreePath: existing.worktreePath,
            pid: existing.pid,
          });
          if (promoted) console.log('Promoted task ' + existing.taskId + ' → building (dispatch live)');
        }
        verifyDispatchWorktree(ws, existing, args, isolation);
        return;
      }
    }

    writeJsonPretty(path.join(ws.dispatches, rec.id + '.json'), rec);
    console.log('Recorded dispatch ' + rec.id + ' (task ' + rec.taskId + ', agent ' + rec.agentLabel + ')');
    if (rec.status === 'running') {
      const promoted = promoteTaskBuildingOnDispatch(ws, rec.taskId, {
        agentLabel: rec.agentLabel,
        worktree: rec.worktree,
        worktreePath: rec.worktreePath,
        pid: rec.pid,
      });
      if (promoted) console.log('Promoted task ' + rec.taskId + ' → building (dispatch live)');
    }
    verifyDispatchWorktree(ws, rec, args, isolation);
    return;
  }

  if (action === 'update') {
    const id = requiredString(args.id, 200, 'id');
    const file = path.join(ws.dispatches, id + '.json');
    if (!fs.existsSync(file)) die('Unknown dispatch id: ' + id);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (args.status) {
      if (!DISPATCH_STATUSES.has(args.status)) die('Invalid dispatch status: ' + args.status + ' (valid: ' + [...DISPATCH_STATUSES].join(', ') + ')');
      rec.status = args.status;
    }
    if (args.session && args.session !== 'true') rec.sessionId = bounded(args.session, 200);
    if (args.pid && args.pid !== 'true') rec.pid = Number(args.pid);
    if (args['worktree-path'] && args['worktree-path'] !== 'true') {
      rec.worktreePath = bounded(args['worktree-path'], 500);
    }
    if (args['exit-code'] !== undefined && args['exit-code'] !== 'true') rec.exitCode = Number(args['exit-code']);
    if (args.note) rec.note = bounded(args.note, 1000);
    rec.updatedAt = Date.now();
    writeJsonPretty(file, rec);
    console.log('Updated dispatch ' + id);
    return;
  }

  if (action === 'list') {
    // Self-heal dead PIDs unless explicitly disabled (tests / freeze-board).
    if (args['no-reconcile'] !== 'true') {
      const healed = reconcileDeadDispatches(ws);
      if (healed.length && args.json !== 'true') {
        for (const c of healed) {
          console.error('reconciled ' + c.id + ': ' + c.from + ' → ' + c.to + ' (' + c.reason + ')');
        }
      }
    }
    let records = readDispatches(ws);
    if (args.task) records = records.filter((r) => r.taskId === args.task);
    if (args.agent) records = records.filter((r) => r.agentLabel === args.agent);
    if (args.status) records = records.filter((r) => r.status === args.status);
    if (args.json === 'true') {
      console.log(JSON.stringify(records, null, 2));
      return;
    }
    if (records.length === 0) {
      console.log('No dispatches');
      return;
    }
    for (const r of records) {
      const bits = [
        r.id,
        '[' + r.status + ']',
        'task=' + (r.taskId || '—'),
        'agent=' + (r.agentLabel || '—'),
      ];
      if (r.worktree) bits.push('wt=' + r.worktree);
      if (r.sessionId) bits.push('session=' + r.sessionId);
      if (r.pid) bits.push('pid=' + r.pid);
      if (r.logFile) bits.push('log=' + r.logFile);
      console.log(bits.join(' '));
    }
    return;
  }

  if (action === 'reconcile') {
    const dryRun = args['dry-run'] === 'true';
    const changes = reconcileDeadDispatches(ws, { dryRun });
    if (args.json === 'true') {
      console.log(JSON.stringify({ ok: true, dryRun, changes }, null, 2));
      return;
    }
    if (changes.length === 0) {
      console.log(dryRun ? 'No dead running dispatches to reconcile' : 'No dispatches reconciled');
      return;
    }
    for (const c of changes) {
      console.log(
        (dryRun ? 'would reconcile ' : 'reconciled ') +
          c.id +
          ': ' +
          c.from +
          ' → ' +
          c.to +
          '  ' +
          c.reason +
          (c.agentLabel ? '  agent=' + c.agentLabel : ''),
      );
    }
    console.log((dryRun ? 'Would fix ' : 'Fixed ') + changes.length + ' dispatch(es)');
    return;
  }

  die('Usage: swarm dispatch record|update|list|reconcile ...');
}

// ---------------------------------------------------------------------------
// board (rendered from live state; --sync rewrites SWARM_BOARD.md sections)
// ---------------------------------------------------------------------------
function renderTasksTable(state) {
  const lines = [
    '| ID | Task | Owner | Owned Files | Depends On | Status |',
    '|----|------|-------|-------------|------------|--------|',
  ];
  const open = state.tasks.filter((t) => t.status !== 'done');
  if (open.length === 0) {
    lines.push('| — | (no open tasks) | — | — | — | — |');
  }
  for (const t of open) {
    lines.push('| ' + [
      t.id,
      t.title.replace(/\|/g, '\\|'),
      t.ownerAgentLabel || '—',
      (t.ownedFiles || []).join('<br>') || '—',
      (t.dependsOn || []).join(', ') || '—',
      t.status.toUpperCase() + (t.blockedReason ? ' — ' + t.blockedReason.replace(/\|/g, '\\|') : ''),
    ].join(' | ') + ' |');
  }
  return lines.join('\n');
}

function renderDoneTable(state) {
  const lines = [
    '| Task | Agent | Summary | Files |',
    '|------|-------|---------|-------|',
  ];
  const done = state.tasks.filter((t) => t.status === 'done');
  if (done.length === 0) lines.push('| — | — | — | — |');
  for (const t of done) {
    const lastNote = t.notes && t.notes.length ? t.notes[t.notes.length - 1].text : '';
    lines.push('| ' + [
      t.id + ' ' + t.title.replace(/\|/g, '\\|'),
      t.ownerAgentLabel || '—',
      (lastNote || '—').replace(/\|/g, '\\|'),
      (t.ownedFiles || []).join('<br>') || '—',
    ].join(' | ') + ' |');
  }
  return lines.join('\n');
}

function replaceBetween(content, startMarker, endMarker, replacement) {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) return null;
  return content.slice(0, start + startMarker.length) + '\n' + replacement + '\n' + content.slice(end);
}

function boardCommand(ws, argv) {
  const args = parseArgs(argv);
  const state = readState(ws);
  const agents = readAgents(ws);

  if (args.sync === 'true') {
    if (!fs.existsSync(ws.board)) die('No SWARM_BOARD.md at ' + ws.board);
    let content = fs.readFileSync(ws.board, 'utf8');
    const t = replaceBetween(content, '<!-- swarm:tasks:start -->', '<!-- swarm:tasks:end -->', renderTasksTable(state));
    if (t !== null) content = t;
    const d = replaceBetween(content, '<!-- swarm:done:start -->', '<!-- swarm:done:end -->', renderDoneTable(state));
    if (d !== null) content = d;
    if (t === null && d === null) {
      die('Board has no sync markers (<!-- swarm:tasks:start --> / <!-- swarm:done:start -->). Re-init from the current template or add markers manually.');
    }
    fs.writeFileSync(ws.board, content, 'utf8');
    console.log('Synced ' + ws.board + (t === null ? ' (no tasks markers)' : '') + (d === null ? ' (no done markers)' : ''));
    return;
  }

  const goal = state.goals[0];
  console.log('# Grok Swarm Board');
  const pausedInfo = readPause(ws);
  if (pausedInfo) {
    console.log('');
    console.log('!! PAUSED since ' + new Date(pausedInfo.pausedAt).toISOString() + (pausedInfo.reason ? ' — ' + pausedInfo.reason : '') + ' (swarm resume to continue)');
  }
  console.log('');
  if (goal) {
    console.log('Goal [' + goal.status + ']: ' + goal.title);
  } else {
    console.log('Goal: (none — swarm goal create --title "...")');
  }
  console.log('');
  console.log('## Tasks');
  if (state.tasks.length === 0) {
    console.log('  (none)');
  } else {
    for (const t of state.tasks) {
      const owner = t.ownerAgentLabel ? ' @' + t.ownerAgentLabel : '';
      const dep = t.dependsOn && t.dependsOn.length ? ' depends:' + t.dependsOn.join(',') : '';
      console.log('  ' + t.id + ' [' + t.status + ']' + owner + dep);
      console.log('    ' + t.title);
      if (t.ownedFiles && t.ownedFiles.length) console.log('    files: ' + t.ownedFiles.join(', '));
      if (t.blockedReason) console.log('    BLOCKED: ' + t.blockedReason);
    }
  }
  console.log('');
  console.log('## Agents');
  if (agents.length === 0) {
    console.log('  (none registered)');
  } else {
    for (const a of agents) console.log('  ' + a.label + ' (' + (a.role || 'builder') + ')');
  }
  const dispatches = readDispatches(ws).filter((r) => r.status === 'running');
  if (dispatches.length > 0) {
    console.log('');
    console.log('## Running dispatches');
    for (const r of dispatches) {
      console.log('  ' + r.id + ' task=' + r.taskId + ' agent=' + r.agentLabel + (r.worktree ? ' wt=' + r.worktree : '') + (r.logFile ? ' log=' + r.logFile : ''));
    }
  }
}

// ---------------------------------------------------------------------------
// pause / resume — safely halt a swarm and restore it later
// ---------------------------------------------------------------------------
function processAlive(pid) {
  return processKill.isAlive(pid);
}

function updateDispatchFile(ws, id, patch) {
  const file = path.join(ws.dispatches, id + '.json');
  if (!fs.existsSync(file)) return null;
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(rec, patch, { updatedAt: Date.now() });
  writeJsonPretty(file, rec);
  return rec;
}

/**
 * Pause one swarm workspace: tree-kill running dispatches, write pause.json.
 * @param {object} ws
 * @param {object} args parseArgs result
 * @param {{ allowAlreadyPaused?: boolean, quiet?: boolean }} [opts]
 * @returns {object} manifest
 */
function pauseOneSwarm(ws, args, opts) {
  const o = opts || {};
  const existing = readPause(ws);
  if (existing && !o.allowAlreadyPaused) {
    die('Swarm is already paused (since ' + new Date(existing.pausedAt).toISOString() + (existing.reason ? ' — ' + existing.reason : '') + '). Run: swarm resume');
  }
  const noKill = args['no-kill'] === 'true';
  const escalateMs = args['escalate-ms'] != null && args['escalate-ms'] !== 'true'
    ? Number(args['escalate-ms'])
    : 1200;
  const running = readDispatches(ws).filter((r) => r.status === 'running');

  const interrupted = [];
  for (const r of running) {
    const alive = processAlive(r.pid);
    let killResult = 'no-pid';
    if (alive && !noKill) {
      try {
        const res = processKill.killProcessTree(r.pid, { escalateMs: Number.isFinite(escalateMs) ? escalateMs : 1200 });
        killResult = 'tree-kill:' + (res.killed && res.killed.length ? res.killed.length : 0) +
          (res.errors && res.errors.length ? ' errors=' + res.errors.length : '');
      } catch (err) {
        killResult = 'kill-failed: ' + String(err && err.message || err);
      }
    } else if (alive && noKill) {
      killResult = 'left-running (--no-kill)';
    } else if (r.pid) {
      killResult = 'already-exited';
    }
    if (!noKill) {
      updateDispatchFile(ws, r.id, {
        status: 'paused',
        note: 'paused: ' + (bounded(args.reason, 500) || 'swarm pause'),
      });
    }
    interrupted.push({
      dispatchId: r.id,
      taskId: r.taskId,
      agentLabel: r.agentLabel,
      worktree: r.worktree,
      worktreePath: r.worktreePath,
      sessionId: r.sessionId,
      logFile: r.logFile,
      pid: r.pid,
      baseRef: r.baseRef,
      killResult,
    });
  }

  const manifest = {
    pausedAt: Date.now(),
    pausedBy: agentName(),
    reason: bounded(args.reason, 500),
    noKill,
    swarmId: ws.swarmId,
    interrupted,
    rePaused: !!existing,
  };
  writeJsonPretty(ws.pauseFile, manifest);

  if (!o.quiet) {
    if (args.json === 'true') {
      // caller may print; for single-swarm we print in pauseCommand
    } else {
      console.log('Swarm PAUSED swarm=' + ws.swarmId + (manifest.reason ? ' — ' + manifest.reason : '') +
        (existing ? ' (re-paused)' : ''));
      if (interrupted.length === 0) {
        console.log('  No running dispatches to interrupt.');
      } else {
        for (const i of interrupted) {
          console.log('  ' + i.dispatchId + ' task=' + i.taskId + ' agent=' + (i.agentLabel || '—') +
            (i.pid ? ' pid=' + i.pid : '') + ' [' + i.killResult + ']' +
            (i.sessionId ? ' session=' + i.sessionId : ' session=UNKNOWN'));
        }
      }
    }
  }
  return manifest;
}

function stopAllCoordinators(registryRoot) {
  const stopped = [];
  for (const rec of listRunningCoordinators(registryRoot)) {
    try { process.kill(rec.pid, 'SIGTERM'); } catch { /* noop */ }
    const sid = rec.swarmId || 'default';
    try { fs.unlinkSync(coordinatorPidFile(registryRoot, sid)); } catch { /* noop */ }
    try { fs.unlinkSync(legacyCoordinatorPidFile(registryRoot)); } catch { /* noop */ }
    stopped.push({ swarmId: sid, pid: rec.pid });
  }
  return stopped;
}

function stopAllMegaDaemons(registryRoot) {
  const megaRoot = path.join(registryRoot, 'mega');
  const stopped = [];
  if (!fs.existsSync(megaRoot)) return stopped;
  let names = [];
  try { names = fs.readdirSync(megaRoot); } catch { return stopped; }
  for (const name of names) {
    const pidFile = path.join(megaRoot, name, 'daemon.pid');
    if (!fs.existsSync(pidFile)) continue;
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(pidFile, 'utf8')); } catch {
      try { rec = { pid: Number(fs.readFileSync(pidFile, 'utf8').trim()) }; } catch { rec = null; }
    }
    const pid = rec && rec.pid;
    if (pid && processAlive(pid)) {
      try { processKill.killProcessTree(pid, { escalateMs: 800 }); } catch { /* noop */ }
      stopped.push({ megaId: name, pid });
    }
    try { fs.unlinkSync(pidFile); } catch { /* noop */ }
  }
  return stopped;
}

function stopDashboardAndHeal(registryRoot) {
  const out = { dashboard: null, heal: null };
  const dashPid = path.join(registryRoot, 'dashboard.pid');
  if (fs.existsSync(dashPid)) {
    try {
      const rec = JSON.parse(fs.readFileSync(dashPid, 'utf8'));
      if (rec && rec.pid && processAlive(rec.pid)) {
        try { process.kill(rec.pid, 'SIGTERM'); } catch { /* noop */ }
        out.dashboard = rec.pid;
      }
    } catch {
      try {
        const pid = Number(fs.readFileSync(dashPid, 'utf8').trim());
        if (processAlive(pid)) { process.kill(pid, 'SIGTERM'); out.dashboard = pid; }
      } catch { /* noop */ }
    }
    try { fs.unlinkSync(dashPid); } catch { /* noop */ }
  }
  const healPid = path.join(registryRoot, 'heal', 'healer.pid');
  if (fs.existsSync(healPid)) {
    try {
      const rec = JSON.parse(fs.readFileSync(healPid, 'utf8'));
      if (rec && rec.pid && processAlive(rec.pid)) {
        try { process.kill(rec.pid, 'SIGTERM'); } catch { /* noop */ }
        out.heal = rec.pid;
      }
    } catch {
      try {
        const pid = Number(fs.readFileSync(healPid, 'utf8').trim());
        if (processAlive(pid)) { process.kill(pid, 'SIGTERM'); out.heal = pid; }
      } catch { /* noop */ }
    }
    try { fs.unlinkSync(healPid); } catch { /* noop */ }
  }
  return out;
}

function collectWorktreePaths(registryRoot) {
  const paths = [];
  const swarmsDir = path.join(registryRoot, 'swarms');
  if (!fs.existsSync(swarmsDir)) return paths;
  for (const sid of fs.readdirSync(swarmsDir)) {
    const disp = path.join(swarmsDir, sid, 'dispatches');
    if (!fs.existsSync(disp)) continue;
    for (const f of fs.readdirSync(disp)) {
      if (!f.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(disp, f), 'utf8'));
        if (rec.worktreePath) paths.push(rec.worktreePath);
      } catch { /* noop */ }
    }
  }
  return paths;
}

/**
 * Registry-wide pause: every swarm + tree-kill + orphan scavenge + stop daemons.
 * This is the operator default for mega / multi-swarm hosts.
 */
function pauseAllCommand(registryRoot, argv) {
  const args = parseArgs(argv);
  const registry = ensureRegistry(registryRoot);
  const repoRoot = path.dirname(registryRoot);
  const manifests = [];
  const swarmIds = (registry.swarms || []).map((s) => s.id).filter(Boolean);

  // Also pause any on-disk swarm dirs not in registry
  const swarmsDir = path.join(registryRoot, 'swarms');
  if (fs.existsSync(swarmsDir)) {
    for (const name of fs.readdirSync(swarmsDir)) {
      if (!swarmIds.includes(name) && fs.existsSync(path.join(swarmsDir, name, 'dispatches'))) {
        swarmIds.push(name);
      }
    }
  }

  for (const sid of swarmIds) {
    const ws = buildWorkspace(registryRoot, sid);
    if (!fs.existsSync(ws.root)) continue;
    try {
      // --all prints a registry summary only (not per-swarm noise)
      manifests.push(pauseOneSwarm(ws, args, { allowAlreadyPaused: true, quiet: true }));
    } catch (err) {
      console.error('pause swarm=' + sid + ' failed: ' + (err && err.message || err));
    }
  }

  const coords = args['no-kill'] === 'true' ? [] : stopAllCoordinators(registryRoot);
  const megas = args['no-kill'] === 'true' ? [] : stopAllMegaDaemons(registryRoot);
  const aux = args['no-kill'] === 'true' ? { dashboard: null, heal: null } : stopDashboardAndHeal(registryRoot);

  let scavenge = { targets: [], trees: [] };
  if (args['no-kill'] !== 'true' && args['no-scavenge'] !== 'true') {
    const wtPaths = collectWorktreePaths(registryRoot);
    scavenge = processKill.killSwarmWorkerOrphans({
      repoBasename: path.basename(repoRoot),
      worktreePaths: wtPaths,
      escalateMs: 1000,
    });
  }

  // Residual check (evidence before claiming done)
  const residual = processKill.listSwarmWorkerOrphans({
    repoBasename: path.basename(repoRoot),
    worktreePaths: collectWorktreePaths(registryRoot),
  });

  const summary = {
    mode: 'all',
    pausedAt: Date.now(),
    reason: bounded(args.reason, 500),
    swarms: manifests.length,
    interruptedTotal: manifests.reduce((n, m) => n + (m.interrupted || []).length, 0),
    coordinatorsStopped: coords,
    megaDaemonsStopped: megas,
    dashboardStopped: aux.dashboard,
    healStopped: aux.heal,
    scavenged: (scavenge.targets || []).length,
    residualAlive: residual.length,
    residual: residual.slice(0, 20).map((r) => ({ pid: r.pid, reason: r.reason, cmd: (r.cmd || '').slice(0, 120) })),
    manifests,
  };

  if (args.json === 'true') {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('Registry PAUSED --all' + (summary.reason ? ' — ' + summary.reason : ''));
    console.log('  swarms paused: ' + summary.swarms + '  dispatches interrupted: ' + summary.interruptedTotal);
    console.log('  coordinators stopped: ' + coords.length + '  mega daemons stopped: ' + megas.length);
    if (aux.dashboard) console.log('  dashboard stopped: pid ' + aux.dashboard);
    if (aux.heal) console.log('  heal stopped: pid ' + aux.heal);
    console.log('  orphan scavenged: ' + summary.scavenged);
    if (residual.length) {
      console.log('  WARNING: residual workers/gates still alive: ' + residual.length + ' (NOT done)');
      for (const r of residual.slice(0, 10)) {
        console.log('    pid ' + r.pid + ' [' + r.reason + '] ' + (r.cmd || '').slice(0, 100));
      }
      console.log('  Fix: re-run `swarm pause --all` or kill those PIDs, then re-check.');
    } else {
      console.log('  residual check: 0 (verified)');
    }
    console.log('State preserved: worktrees/sessions/dispatches. Resume: swarm resume --all (or per --swarm).');
  }
  if (residual.length) process.exitCode = 2;
  return summary;
}

function pauseCommand(ws, argv) {
  const args = parseArgs(argv);
  // Multi-swarm safety: if registry has 2+ swarms and user did not pass --swarm / SWARM_ID,
  // require --all (or explicit --swarm). Detect via env + args already resolved into ws —
  // callers pass --all at main. Single-swarm path:
  const manifest = pauseOneSwarm(ws, args, { allowAlreadyPaused: false });

  // Scavenge orphans scoped to this swarm's worktrees + repo basename
  let scavenge = { targets: [] };
  if (args['no-kill'] !== 'true' && args['no-scavenge'] !== 'true') {
    const wts = (manifest.interrupted || []).map((i) => i.worktreePath).filter(Boolean);
    scavenge = processKill.killSwarmWorkerOrphans({
      repoBasename: path.basename(ws.repoRoot),
      worktreePaths: wts,
      escalateMs: 1000,
    });
  }
  const residual = processKill.listSwarmWorkerOrphans({
    repoBasename: path.basename(ws.repoRoot),
    worktreePaths: (manifest.interrupted || []).map((i) => i.worktreePath).filter(Boolean),
  });

  if (args.json === 'true') {
    console.log(JSON.stringify({ ...manifest, scavenged: (scavenge.targets || []).length, residualAlive: residual.length, residual }, null, 2));
    if (residual.length) process.exitCode = 2;
    return;
  }
  if ((scavenge.targets || []).length) {
    console.log('  orphan scavenged: ' + scavenge.targets.length);
  }
  if (residual.length) {
    console.log('  WARNING: residual workers/gates still alive: ' + residual.length);
    for (const r of residual.slice(0, 8)) {
      console.log('    pid ' + r.pid + ' [' + r.reason + '] ' + (r.cmd || '').slice(0, 100));
    }
    process.exitCode = 2;
  } else {
    console.log('  residual check: 0 (verified)');
  }
  console.log('State preserved: events, mailboxes, dispatch records, and grok sessions/worktrees are untouched.');
  console.log('Resume with: swarm resume' + (ws.swarmId && ws.swarmId !== 'default' ? ' --swarm ' + ws.swarmId : ''));
}


/**
 * Host RAM guard: if MemAvailable < min_free_ram_gb (default 2G), pause --all.
 * Rate-limited via .grok-swarm/host-memory-guard.json. Safe to call from dashboard/watch polls.
 * @param {string} registryRoot
 * @param {{ force?: boolean, reason?: string }} [opts]
 * @returns {{ mem: object, triggered: boolean, skipped?: string, summary?: object }}
 */
function maybeAutoPauseLowMemory(registryRoot, opts) {
  const o = opts || {};
  let minFreeGb = hostStats.DEFAULT_MIN_FREE_GB;
  let enabled = true;
  try {
    const cap = require('./capacity.cjs').loadHostCapacity(registryRoot);
    if (cap.min_free_ram_gb != null && Number.isFinite(Number(cap.min_free_ram_gb))) {
      minFreeGb = Number(cap.min_free_ram_gb);
    }
    if (cap.auto_pause_low_memory === 0 || cap.auto_pause_low_memory === false) {
      enabled = false;
    }
  } catch { /* defaults */ }

  const mem = hostStats.hostMemoryPayload({ minFreeGb });
  if (!enabled) {
    return { mem, triggered: false, skipped: 'disabled' };
  }
  if (!hostStats.isLowMemory(mem, minFreeGb)) {
    return { mem, triggered: false };
  }

  const prev = hostStats.readGuardState(registryRoot);
  const now = Date.now();
  const cooldown = hostStats.DEFAULT_COOLDOWN_MS;
  if (!o.force && prev && prev.lastTriggeredAt && now - prev.lastTriggeredAt < cooldown) {
    return {
      mem,
      triggered: false,
      skipped: 'cooldown',
      lastTriggeredAt: prev.lastTriggeredAt,
      lastReason: prev.reason,
    };
  }

  const reason =
    o.reason ||
    ('auto-pause: MemAvailable ' + mem.availableGb + 'G < ' + minFreeGb + 'G threshold');
  let summary = null;
  const prevExit = process.exitCode;
  try {
    // Human summary goes to dashboard/watch process log (rate-limited by cooldown).
    summary = pauseAllCommand(registryRoot, ['--reason', reason]);
    console.error('[host-memory-guard] ' + reason + ' — registry pause --all executed');
  } catch (err) {
    console.error('[host-memory-guard] pause failed: ' + (err && err.message || err));
    hostStats.writeGuardState(registryRoot, {
      lastTriggeredAt: now,
      reason,
      error: String(err && err.message || err),
      mem,
    });
    process.exitCode = prevExit;
    return { mem, triggered: false, skipped: 'pause-error', error: String(err && err.message || err) };
  }
  process.exitCode = prevExit;

  hostStats.writeGuardState(registryRoot, {
    lastTriggeredAt: now,
    reason,
    availableGb: mem.availableGb,
    minFreeGb,
    interruptedTotal: summary && summary.interruptedTotal,
  });
  return { mem: { ...mem, low: true, autoPaused: true }, triggered: true, summary };
}

function attachHostMemory(payload, registryRoot, opts) {
  const guard = maybeAutoPauseLowMemory(registryRoot, opts);
  const next = payload && typeof payload === 'object' ? { ...payload } : {};
  next.hostMemory = guard.mem;
  next.memoryGuard = {
    triggered: !!guard.triggered,
    skipped: guard.skipped || null,
    minFreeGb: guard.mem && guard.mem.minFreeGb,
    lastTriggeredAt: guard.lastTriggeredAt || null,
  };
  return next;
}

function resumeCommand(ws, argv) {
  const args = parseArgs(argv);
  const manifest = readPause(ws);
  if (!manifest) die('Swarm is not paused (no pause.json). Nothing to resume.');

  // Archive the manifest so pause history is auditable.
  fs.mkdirSync(ws.pauseHistory, { recursive: true });
  const archived = path.join(ws.pauseHistory, 'pause-' + manifest.pausedAt + '.json');
  fs.renameSync(ws.pauseFile, archived);

  const state = readState(ws);
  const byId = new Map(state.tasks.map((t) => [t.id, t]));
  const pending = (manifest.interrupted || []).filter((i) => {
    const t = byId.get(i.taskId);
    return !t || !TERMINAL_TASK.has(t.status);
  });

  const resumePlan = pending.map((i) => {
    const t = byId.get(i.taskId);
    const title = t ? t.title : i.taskId;
    const cmd = buildResumeGrokCommand(i, title);
    return { ...i, taskTitle: title, taskStatus: t ? t.status : 'unknown', resumeCommand: cmd };
  });

  if (args.json === 'true') {
    console.log(JSON.stringify({ pausedAt: manifest.pausedAt, reason: manifest.reason, archivedManifest: archived, resumePlan }, null, 2));
    return;
  }
  console.log('Swarm RESUMED (was paused since ' + new Date(manifest.pausedAt).toISOString() + (manifest.reason ? ' — ' + manifest.reason : '') + ')');
  console.log('Pause manifest archived: ' + archived);
  if (resumePlan.length === 0) {
    console.log('No interrupted dispatches need relaunching (all their tasks are done/cancelled).');
  } else {
    console.log('');
    console.log('Relaunch each interrupted builder (coordinator: run in background, then `swarm dispatch record` each new run):');
    for (const p of resumePlan) {
      console.log('');
      console.log('# task ' + p.taskId + ' [' + p.taskStatus + '] ' + p.taskTitle + (p.logFile ? '  (old log: ' + p.logFile + ')' : ''));
      console.log(p.resumeCommand);
    }
  }
  console.log('');
  console.log('Then: swarm task ready / swarm check to confirm the plan, and swarm board --sync.');
}

// ---------------------------------------------------------------------------
// dashboard — tiny local web app for live swarm progress
// ---------------------------------------------------------------------------
function dashboardHtmlPath() {
  return path.join(path.dirname(__dirname), 'templates', 'dashboard.html');
}

// Shared human-readable one-liner per task — used by the browser dashboard
// (embedded via /api/state) and `swarm watch`.
function taskFriendlyStatus(t, byId) {
  const owner = t.ownerAgentLabel || 'Someone';
  switch (t.status) {
    case 'open': return 'Waiting to be picked up';
    case 'assigned': {
      const waiting = (t.dependsOn || []).filter((d) => {
        const dep = byId.get(d);
        return dep && dep.status !== 'done';
      });
      return waiting.length ? 'Waiting on ' + waiting.join(', ') : owner + ' is queued to start';
    }
    case 'planning': return owner + ' is planning the approach';
    case 'building': return owner + ' is building';
    case 'review': return 'Ready for review by the coordinator';
    case 'blocked': return 'BLOCKED' + (t.blockedReason ? ': ' + t.blockedReason : '');
    case 'done': return 'Done';
    case 'cancelled': return 'Cancelled';
    default: return t.status;
  }
}

function buildActivityFeed(ws, limit) {
  const feed = [];
  for (const ev of readEvents(ws)) {
    if (ev.type === 'task_note_added' && ev.note && ev.note.text) {
      feed.push({
        type: 'note', taskId: ev.taskId, agentLabel: ev.note.agentLabel || ev.actorLabel,
        text: ev.note.text, timestamp: ev.note.timestamp || ev.timestamp,
      });
    } else if (ev.type === 'task_created' && ev.task) {
      feed.push({
        type: 'task_created', taskId: ev.task.id, agentLabel: ev.actorLabel,
        text: 'Created: ' + (ev.task.title || ev.task.id), timestamp: ev.timestamp,
      });
    } else if (ev.type === 'task_updated' && ev.task && ev.task.status) {
      feed.push({
        type: 'status', taskId: ev.task.id, agentLabel: ev.actorLabel,
        text: 'Status -> ' + ev.task.status, status: ev.task.status, timestamp: ev.timestamp,
      });
    }
  }
  feed.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return feed.slice(0, limit);
}

function dashboardState(ws) {
  const state = readState(ws);
  const goal = state.goals[0] || null;
  const byId = new Map(state.tasks.map((t) => [t.id, t]));
  const tasks = state.tasks.filter((t) => t.status !== 'cancelled');
  const done = tasks.filter((t) => t.status === 'done').length;
  // Heal "running + dead PID" before any UI/watch snapshot (prevents 26m (exited?) ghosts).
  const reconciled = reconcileDeadDispatches(ws);
  const dispatches = readDispatches(ws);
  const paused = readPause(ws);
  const now = Date.now();

  const counts = {};
  for (const s of TASK_STATUSES) counts[s] = 0;
  for (const t of state.tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  const readyCount = state.tasks.filter((t) =>
    (t.status === 'open' || t.status === 'assigned') && depsAllDone(t, byId)).length;

  const running = dispatches.filter((r) => r.status === 'running').map((r) => {
    const t = byId.get(r.taskId);
    const pidAlive = isPidAlive(r.pid);
    return {
      ...r,
      taskTitle: t ? t.title : r.taskId,
      elapsedMs: now - (r.createdAt || now),
      pidAlive: pidAlive === true ? true : pidAlive === false ? false : undefined,
    };
  });

  const reviewN = counts.review || 0;
  const buildingN = counts.building || 0;
  // Weighted progress: done=1, review=0.85 (work finished, board lag), building=0.5
  // Prevents "0% + Idle" deception when all packs are in review after builders exit.
  let weighted = 0;
  for (const t of tasks) {
    if (t.status === 'done') weighted += 1;
    else if (t.status === 'review') weighted += 0.85;
    else if (t.status === 'building' || t.status === 'planning') weighted += 0.5;
    else if (t.status === 'assigned' || t.status === 'open') weighted += 0.1;
  }
  const pctWeighted =
    tasks.length > 0 ? Math.round((weighted / tasks.length) * 100) : 0;
  const pctStrict = tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0;
  const coordinatorLag =
    running.length === 0 &&
    reviewN > 0 &&
    dispatches.some((d) => d.status === 'done') &&
    !dispatches.some((d) => d.status === 'running');

  const stats = {
    counts,
    done,
    total: tasks.length,
    pct: pctWeighted,
    pctStrict,
    runningDispatches: running.length,
    readyCount,
    review: reviewN,
    building: buildingN,
    coordinatorLag: !!coordinatorLag,
    // Plain-language phase for the green/blue pill — never "Idle" while review is blocked on coord
    phase:
      running.length > 0
        ? 'live'
        : coordinatorLag
          ? 'coord-lag'
          : reviewN > 0
            ? 'review'
            : done >= tasks.length && tasks.length > 0
              ? 'done'
              : 'idle',
  };

  const recentDone = state.tasks
    .filter((t) => t.status === 'done')
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
    .slice(0, 8);

  // Rough ETA from median done-task duration; omitted when unreliable.
  let eta = null;
  const durations = state.tasks
    .filter((t) => t.status === 'done' && t.completedAt && t.createdAt && t.completedAt > t.createdAt)
    .map((t) => t.completedAt - t.createdAt)
    .sort((a, b) => a - b);
  if (durations.length >= 2) {
    const median = durations[Math.floor(durations.length / 2)];
    const remaining = tasks.length - done;
    if (remaining > 0) eta = { medianTaskMs: median, remainingTasks: remaining, estimatedMsLeft: median * remaining };
  }

  const agents = readAgents(ws);
  const agentWorkload = agents.map((a) => ({
    label: a.label,
    role: a.role || 'builder',
    active: state.tasks.filter((t) => t.ownerAgentLabel === a.label && !TERMINAL_TASK.has(t.status)).length,
    done: state.tasks.filter((t) => t.ownerAgentLabel === a.label && t.status === 'done').length,
  }));

  let resumePlan = null;
  if (paused) {
    resumePlan = (paused.interrupted || []).map((i) => {
      const t = byId.get(i.taskId);
      const title = t ? t.title : i.taskId;
      return { ...i, taskTitle: title, taskStatus: t ? t.status : 'unknown', resumeCommand: buildResumeGrokCommand(i, title) };
    });
  }

  const dispatchHistory = [...dispatches]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 10)
    .map((r) => ({
      ...r,
      taskTitle: (byId.get(r.taskId) || {}).title || r.taskId,
      elapsedMs: r.status === 'running' ? now - (r.createdAt || now) : (r.updatedAt || now) - (r.createdAt || now),
    }));

  const friendly = {};
  for (const t of state.tasks) friendly[t.id] = taskFriendlyStatus(t, byId);

  const skillBin = path.join(skillRootDir(), 'bin', 'swarm');
  const guide = buildOperatorGuide({
    repoRoot: ws.repoRoot,
    swarmId: ws.swarmId,
    skillBin,
    workspace: ws.root,
    registryRoot: ws.registryRoot,
  });

  // Live daemon snapshot for the Guide panel
  const coordRec = readCoordinatorPid(ws.registryRoot, ws.swarmId);
  let healer = { alive: false, pid: null };
  try {
    const healFile = path.join(ws.registryRoot, 'heal', 'healer.pid');
    if (fs.existsSync(healFile)) {
      const h = JSON.parse(fs.readFileSync(healFile, 'utf8'));
      if (h && h.pid && isPidAlive(h.pid) === true) {
        healer = { alive: true, pid: h.pid, startedAt: h.startedAt || null };
      }
    }
  } catch { /* ignore */ }
  let dashboardDaemon = { alive: false, pid: null, port: null };
  try {
    const dashFile = path.join(ws.registryRoot, 'dashboard.pid');
    if (fs.existsSync(dashFile)) {
      const d = JSON.parse(fs.readFileSync(dashFile, 'utf8'));
      if (d && d.pid && isPidAlive(d.pid) === true) {
        dashboardDaemon = {
          alive: true,
          pid: d.pid,
          port: d.port || null,
          url: d.port ? 'http://127.0.0.1:' + d.port + '/' : null,
        };
      }
    }
  } catch { /* ignore */ }

  let capacity = null;
  try {
    const capacityApi = require('./capacity.cjs');
    if (capacityApi && typeof capacityApi.loadHostCapacity === 'function') {
      capacity = capacityApi.loadHostCapacity(ws.registryRoot);
    }
  } catch { /* optional */ }

  const operator = {
    ...guide,
    daemons: {
      coordinator: coordRec
        ? {
            alive: true,
            pid: coordRec.pid,
            swarmId: coordRec.swarmId || ws.swarmId,
            sessionId: coordRec.sessionId || null,
            logFile: coordinatorLogFile(ws.registryRoot, ws.swarmId),
          }
        : { alive: false, pid: null, swarmId: ws.swarmId },
      healer,
      dashboard: dashboardDaemon,
    },
    paths: {
      repoRoot: ws.repoRoot,
      registryRoot: ws.registryRoot,
      workspace: ws.root,
      board: ws.board,
      dispatches: ws.dispatches,
      events: ws.events,
      coordinatorLog: coordinatorLogFile(ws.registryRoot, ws.swarmId),
      coordinatorPrompt: coordinatorPromptFile(ws.registryRoot, ws.swarmId),
    },
    capacity,
    taskDetails: state.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      owner: t.ownerAgentLabel || null,
      files: t.ownedFiles || t.files || [],
      dependsOn: t.dependsOn || [],
      acceptance: t.acceptanceCriteria || t.acceptance || null,
      blockedReason: t.blockedReason || null,
      note: t.note || null,
      updatedAt: t.updatedAt || null,
      completedAt: t.completedAt || null,
      friendly: friendly[t.id] || null,
    })),
    dispatchDetails: dispatches
      .slice()
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 25)
      .map((r) => ({
        id: r.id,
        taskId: r.taskId,
        taskTitle: (byId.get(r.taskId) || {}).title || r.taskId,
        agentLabel: r.agentLabel,
        status: r.status,
        pid: r.pid,
        pidAlive: isPidAlive(r.pid),
        worktree: r.worktree || null,
        worktreePath: r.worktreePath || null,
        logFile: r.logFile || null,
        sessionId: r.sessionId || null,
        base: r.base || null,
        exitCode: r.exitCode,
        note: r.note || null,
        totalCostUsd: r.totalCostUsd ?? null,
        numTurns: r.numTurns ?? null,
        stopReason: r.stopReason || null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
  };

  return {
    apiVersion: 2,
    goal,
    tasks: state.tasks,
    agents,
    dispatches,
    progress: { done, total: tasks.length },
    paused,
    workspace: ws.root,
    repoRoot: ws.repoRoot,
    updatedAt: now,
    // v2 additions
    stats,
    recentDone,
    repoName: path.basename(ws.repoRoot),
    swarmId: ws.swarmId,
    boardHealth: validateBoard(state),
    activityFeed: buildActivityFeed(ws, 20),
    resumePlan,
    dispatchHistory,
    runningDispatches: running,
    eta,
    agentWorkload,
    friendlyStatus: friendly,
    reconciledDispatches: reconciled,
    operator,
  };
}

// ---------------------------------------------------------------------------
// log tail — bounded read from a dispatch's log file (streaming-json aware)
// ---------------------------------------------------------------------------
const LOG_TAIL_MAX_BYTES = 256 * 1024;
const LOG_TAIL_MAX_LINES = 80;
/** Raw NDJSON lines scanned before coalescing (thought deltas are 1 token each). */
const LOG_TAIL_RAW_SCAN = 400;

/** Decode a JSON array of byte values to UTF-8 text (Grok rawOutput.output). */
function decodeByteArray(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  if (typeof arr[0] !== 'number') return '';
  try {
    return Buffer.from(arr).toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Pull human-readable text out of a Grok streaming-json event.
 * Events vary: thought deltas use `data`; tool results nest under
 * content[].content.text or rawOutput.output_for_prompt / byte arrays.
 */
function extractStreamingEventText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (typeof obj.data === 'string') return obj.data;
  if (typeof obj.text === 'string') return obj.text;
  if (typeof obj.message === 'string') return obj.message;
  if (typeof obj.delta === 'string') return obj.delta;

  if (Array.isArray(obj.content)) {
    const parts = [];
    for (const c of obj.content) {
      if (!c) continue;
      if (typeof c === 'string') {
        parts.push(c);
        continue;
      }
      if (typeof c.text === 'string') {
        parts.push(c.text);
        continue;
      }
      if (c.content) {
        if (typeof c.content === 'string') parts.push(c.content);
        else if (typeof c.content.text === 'string') parts.push(c.content.text);
      }
    }
    if (parts.length) return parts.join('');
  }

  if (obj.rawOutput && typeof obj.rawOutput === 'object') {
    if (typeof obj.rawOutput.output_for_prompt === 'string') return obj.rawOutput.output_for_prompt;
    if (typeof obj.rawOutput.output === 'string') return obj.rawOutput.output;
    const decoded = decodeByteArray(obj.rawOutput.output);
    if (decoded) return decoded;
  }

  if (obj.type === 'tool_call') {
    const name = obj.toolName || obj.title || 'tool';
    const status = obj.status || '';
    let input = '';
    if (typeof obj.rawInput === 'string') input = obj.rawInput;
    else if (obj.rawInput && typeof obj.rawInput === 'object') {
      try {
        input = JSON.stringify(obj.rawInput);
      } catch {
        input = '';
      }
    }
    if (input.length > 240) input = input.slice(0, 239) + '…';
    return [name, status, input].filter(Boolean).join(' · ');
  }

  // Noise events with no user-visible body
  if (obj.type === 'usage' || obj.type === 'available_commands' || obj.type === 'ping') return '';
  return '';
}

function parseStreamingJsonLine(line) {
  const trimmed = String(line || '').trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && typeof obj.type === 'string') {
        const data = extractStreamingEventText(obj);
        return {
          type: obj.type,
          data: data || undefined,
          toolCallId: typeof obj.toolCallId === 'string' ? obj.toolCallId : undefined,
          status: typeof obj.status === 'string' ? obj.status : undefined,
        };
      }
    } catch { /* fall through to raw */ }
  }
  return { type: 'raw', data: String(line || '') };
}

/**
 * Collapse token-by-token thought deltas and drop empty noise so the UI
 * shows full-width readable lines instead of a left-aligned column of crumbs.
 */
function coalesceLogEvents(events) {
  const out = [];
  // Grok streams these as 1–6 char crumbs per NDJSON line — merge into paragraphs.
  const streamTypes = { thought: 1, text: 1, assistant: 1, message: 1, delta: 1 };
  for (const ev of events) {
    if (!ev) continue;
    const type = ev.type || 'raw';
    let data = typeof ev.data === 'string' ? ev.data : '';

    // Skip pure noise
    if (!data && (type === 'usage' || type === 'available_commands' || type === 'ping')) continue;
    if (!data && type !== 'raw' && type !== 'tool_call') continue;

    const prev = out[out.length - 1];
    if (
      prev &&
      streamTypes[prev.type] &&
      streamTypes[type] &&
      typeof prev.data === 'string'
    ) {
      prev.data += data;
      continue;
    }
    // Merge sequential tool_call_update bodies for the same call (or when id missing)
    if (
      prev &&
      prev.type === 'tool_call_update' &&
      type === 'tool_call_update' &&
      data &&
      (!ev.toolCallId || !prev.toolCallId || ev.toolCallId === prev.toolCallId)
    ) {
      // Prefer longer / newer full dump over partial prefix
      if (data.length >= (prev.data || '').length && data.startsWith(prev.data || '')) {
        prev.data = data;
      } else if (!(prev.data || '').includes(data)) {
        prev.data = (prev.data || '') + (prev.data && !prev.data.endsWith('\n') ? '\n' : '') + data;
      }
      if (ev.status) prev.status = ev.status;
      continue;
    }
    // Dedupe identical adjacent lines
    if (prev && prev.type === type && prev.data === data && data) continue;

    out.push({
      type,
      data: data || undefined,
      toolCallId: ev.toolCallId,
      status: ev.status,
    });
  }
  // Normalize stream whitespace after coalesce
  for (const e of out) {
    if (streamTypes[e.type] && typeof e.data === 'string') {
      e.data = e.data.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    }
  }
  return out.filter((e) => (e.data && e.data.length > 0) || e.type === 'raw');
}

/**
 * Tail-parse any streaming-json log (coordinator or builder) into coalesced,
 * human-readable events. Returns [] when the file is missing/unreadable.
 * Used by GET /api/activity — the dashboard "Live feed" panel.
 */
function tailStreamEvents(logFile, cap) {
  if (!logFile || !fs.existsSync(logFile)) return [];
  let text = '';
  try {
    const stat = fs.statSync(logFile);
    const start = Math.max(0, stat.size - LOG_TAIL_MAX_BYTES);
    const fd = fs.openSync(logFile, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const allLines = text.split('\n').filter((l) => l.length > 0);
  const rawTail = allLines.slice(-Math.max(cap * 5, Math.min(LOG_TAIL_RAW_SCAN, allLines.length)));
  const events = coalesceLogEvents(rawTail.map(parseStreamingJsonLine));
  // Keep payloads dashboard-sized: the feed is a ticker, not a log viewer.
  return events.slice(-cap).map((e) => ({
    type: e.type,
    status: e.status,
    data: typeof e.data === 'string' && e.data.length > 500 ? e.data.slice(0, 499) + '…' : e.data,
  }));
}

function readLogTail(ws, dispatchId, { lines = 40, format = 'structured' } = {}) {
  if (!/^run-[a-z0-9-]+$/.test(dispatchId)) {
    return { error: 'invalid dispatch id', status: 400 };
  }
  const file = path.join(ws.dispatches, dispatchId + '.json');
  if (!fs.existsSync(file)) return { error: 'unknown dispatch', status: 404 };
  let rec;
  try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { error: 'corrupt dispatch record', status: 500 }; }

  const cap = Math.max(1, Math.min(Number(lines) || 40, LOG_TAIL_MAX_LINES));
  const empty = { dispatchId, logFile: rec.logFile || null, truncated: false, byteSize: 0, rawLineCount: 0 };
  if (!rec.logFile || !fs.existsSync(rec.logFile)) {
    return format === 'plain' ? { ...empty, lines: [] } : { ...empty, events: [] };
  }

  let text = '';
  let truncated = false;
  let byteSize = 0;
  try {
    const stat = fs.statSync(rec.logFile);
    byteSize = stat.size;
    const start = Math.max(0, stat.size - LOG_TAIL_MAX_BYTES);
    truncated = start > 0;
    const fd = fs.openSync(rec.logFile, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return { ...empty, error: 'log read failed: ' + String(err && err.message || err), status: 500 };
  }

  const allLines = text.split('\n').filter((l) => l.length > 0);
  // Scan more raw NDJSON than we return — thought streams are one token per line.
  const rawTail = allLines.slice(-Math.max(cap * 5, Math.min(LOG_TAIL_RAW_SCAN, allLines.length)));
  const coalesced = coalesceLogEvents(rawTail.map(parseStreamingJsonLine));
  const events = coalesced.slice(-cap);
  const base = {
    dispatchId,
    logFile: rec.logFile,
    truncated: truncated || allLines.length > rawTail.length,
    byteSize,
    rawLineCount: allLines.length,
    eventCount: events.length,
  };
  if (format === 'plain') {
    return {
      ...base,
      lines: events.map((e) => e.data || '').filter(Boolean),
    };
  }
  return { ...base, events };
}

function formatDuration(ms) {
  const sec = Math.max(0, Math.floor((ms || 0) / 1000));
  if (sec < 60) return sec + 's';
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return min + 'm' + String(rem).padStart(2, '0') + 's';
  const hr = Math.floor(min / 60);
  return hr + 'h' + String(min % 60).padStart(2, '0') + 'm';
}

function ansi(code, text, enabled) {
  return enabled ? '\x1b[' + code + 'm' + text + '\x1b[0m' : text;
}

function truncate(text, width) {
  const s = String(text ?? '');
  if (s.length <= width) return s;
  return s.slice(0, Math.max(0, width - 1)) + '…';
}

function dashboardOverviewState(registryRoot) {
  const registry = ensureRegistry(registryRoot);
  const now = Date.now();

  // Reconcile registry against swarms/ on disk. A re-scaffolded registry.json
  // (e.g. init --fresh) drops pack registrations, and an overview that only
  // iterates registry.swarms reports a false "idle / all done" while live pack
  // dirs still exist (2026-07-18 audit S1). Recent unregistered dirs are shown
  // as swarms; older ones are only counted so stale archives don't flood the UI.
  const knownIds = new Set(registry.swarms.map((s) => s.id));
  const unregistered = [];
  try {
    const swarmsDir = path.join(registryRoot, 'swarms');
    for (const name of fs.readdirSync(swarmsDir)) {
      if (knownIds.has(name)) continue;
      let dstat;
      try { dstat = fs.statSync(path.join(swarmsDir, name)); } catch { continue; }
      if (!dstat.isDirectory()) continue;
      unregistered.push({ id: name, mtimeMs: dstat.mtimeMs });
    }
  } catch { /* no swarms dir yet */ }
  const UNREGISTERED_RECENT_MS = 48 * 60 * 60 * 1000;
  const recentUnregistered = unregistered.filter((u) => now - u.mtimeMs < UNREGISTERED_RECENT_MS);
  const swarmDefs = [
    ...registry.swarms,
    ...recentUnregistered.map((u) => ({ id: u.id, title: u.id, unregistered: true })),
  ];

  const runningDispatches = [];
  const activeTasks = [];
  const counts = {
    open: 0, assigned: 0, planning: 0, building: 0, review: 0,
    done: 0, blocked: 0, cancelled: 0,
  };
  let done = 0;
  let total = 0;

  const looksLikePack = (id) => /gh-issues|^mega-|-pack-/.test(String(id));

  const swarms = swarmDefs.map((s) => {
    const ws = buildWorkspace(registryRoot, s.id);
    let st;
    try {
      st = dashboardState(ws);
    } catch (err) {
      return {
        id: s.id,
        title: s.title || s.id,
        isDefault: registry.default === s.id,
        stats: null,
        paused: false,
        goalTitle: null,
        goalStatus: null,
        error: String(err && err.message || err),
      };
    }

    // Aggregate across ALL packs (skip phantom mirrored tasks on default when
    // mega sub-swarms exist — default is a rollup board only).
    const isPack = s.id !== registry.default && looksLikePack(s.id);
    const isDefault = registry.default === s.id;
    const hasMegaPacks = swarmDefs.some((x) => x.id !== registry.default && looksLikePack(x.id));
    const includeInAggregate = !hasMegaPacks || !isDefault || isPack;

    if (includeInAggregate && !isDefault) {
      const sc = (st.stats && st.stats.counts) || {};
      for (const k of Object.keys(counts)) counts[k] += sc[k] || 0;
      done += (st.stats && st.stats.done) || 0;
      total += (st.stats && st.stats.total) || 0;
      for (const r of st.runningDispatches || []) {
        runningDispatches.push({
          ...r,
          swarmId: s.id,
          swarmTitle: s.title || s.id,
        });
      }
      for (const task of st.tasks || []) {
        if (task.status === 'cancelled') continue;
        if (['building', 'planning', 'review', 'blocked', 'assigned', 'open'].includes(task.status)) {
          activeTasks.push({
            id: task.id,
            title: task.title,
            status: task.status,
            ownerAgentLabel: task.ownerAgentLabel,
            blockedReason: task.blockedReason,
            swarmId: s.id,
            swarmTitle: s.title || s.id,
          });
        }
      }
    } else if (!hasMegaPacks && isDefault) {
      // Single-swarm mode / concurrent named swarms: aggregate includes default
      const sc = (st.stats && st.stats.counts) || {};
      for (const k of Object.keys(counts)) counts[k] += sc[k] || 0;
      done += (st.stats && st.stats.done) || 0;
      total += (st.stats && st.stats.total) || 0;
      for (const r of st.runningDispatches || []) {
        runningDispatches.push({ ...r, swarmId: s.id, swarmTitle: s.title || s.id });
      }
      // Without this, the overview kanban silently drops the default swarm's
      // tasks while still counting them in the aggregate (named-peers regression).
      for (const task of st.tasks || []) {
        if (task.status === 'cancelled') continue;
        if (['building', 'planning', 'review', 'blocked', 'assigned', 'open'].includes(task.status)) {
          activeTasks.push({
            id: task.id,
            title: task.title,
            status: task.status,
            ownerAgentLabel: task.ownerAgentLabel,
            blockedReason: task.blockedReason,
            swarmId: s.id,
            swarmTitle: s.title || s.id,
          });
        }
      }
    }

    return {
      id: s.id,
      title: s.title || s.id,
      isDefault: registry.default === s.id,
      unregistered: !!s.unregistered,
      stats: st.stats,
      paused: !!st.paused,
      goalTitle: st.goal ? st.goal.title : null,
      goalStatus: st.goal ? st.goal.status : null,
      live: (st.runningDispatches || []).length,
      building: (st.stats && st.stats.counts && st.stats.counts.building) || 0,
      review: (st.stats && st.stats.counts && st.stats.counts.review) || 0,
    };
  });

  // If mega packs exist, also count default-only done wave1 into totals for pct context
  const def = swarms.find((s) => s.isDefault);
  if (def && def.stats && swarmDefs.some((x) => x.id !== registry.default && looksLikePack(x.id))) {
    done += def.stats.done || 0;
    total += def.stats.done || 0; // only completed wave1 counts toward global done; open ghosts excluded
    counts.done += def.stats.done || 0;
  }

  const aggregate = {
    counts,
    done,
    total: total || 1,
    pct: total > 0 ? Math.round((done / total) * 100) : 0,
    runningDispatches: runningDispatches.length,
    readyCount: 0,
  };

  return {
    apiVersion: 2,
    view: 'overview',
    default: registry.default,
    repoName: path.basename(path.dirname(registryRoot)),
    updatedAt: now,
    swarms,
    unregisteredCount: unregistered.length,
    unregisteredRecent: recentUnregistered.map((u) => u.id),
    aggregate,
    runningDispatches: runningDispatches.sort((a, b) => (b.elapsedMs || 0) - (a.elapsedMs || 0)),
    activeTasks,
    // Shape compatible with single-swarm consumers for monitor hero
    stats: aggregate,
    tasks: activeTasks,
    goal: {
      id: 'goal-overview',
      title: 'All swarms (mission overview)',
      status: 'active',
    },
  };
}

function resolveWatchWorkspace(args) {
  const registryRoot = requireRegistryRoot(args);
  const registry = ensureRegistry(registryRoot);
  if (args.all === 'true') return { mode: 'all', registryRoot, registry };
  const swarmId = resolveSwarmId(registry, args);
  return { mode: 'one', ws: buildWorkspace(registryRoot, swarmId), registryRoot, registry };
}

/** Prefer --repo/--cwd so `swarm watch <mega> --repo /path` works from any cwd. */
function resolveWatchRegistryRoot(args, { required = false } = {}) {
  const start =
    (args.repo && args.repo !== 'true' ? args.repo : null) ||
    (args.cwd && args.cwd !== 'true' ? args.cwd : null) ||
    process.cwd();
  const registryRoot = findWorkspace(start) || findWorkspace(process.cwd());
  if (!registryRoot && required) {
    die(
      'No .grok-swarm/ workspace found (searched up from ' +
        path.resolve(start) +
        '). Pass --repo <path> or run from the repo. Run: swarm init <repoPath>',
    );
  }
  return registryRoot;
}

function megaMissionDir(registryRoot, megaId) {
  return path.join(registryRoot, 'mega', megaId);
}

function isMegaMission(registryRoot, megaId) {
  if (!megaId || typeof megaId !== 'string') return false;
  const dir = megaMissionDir(registryRoot, megaId);
  return (
    fs.existsSync(path.join(dir, 'plan.json')) ||
    fs.existsSync(path.join(dir, 'state.json'))
  );
}

/**
 * Resolve a mega mission id for `swarm watch <name>` / `swarm mega watch`.
 * Accepts positional name, --id, or MEGA_ID when exactly one active mega exists.
 */
function resolveWatchMegaId(args, registryRoot) {
  const candidates = [];
  if (args.id && args.id !== 'true') candidates.push(String(args.id));
  for (const p of args._ || []) {
    if (!p || p === 'true') continue;
    const s = String(p);
    if (s.startsWith('-')) continue;
    // skip known subcommand tokens if any slip through
    if (s === 'status' || s === 'watch') continue;
    candidates.push(s);
  }
  if (process.env.MEGA_ID) candidates.push(process.env.MEGA_ID);

  for (const id of candidates) {
    if (isMegaMission(registryRoot, id)) return id;
  }
  // single active mega when user said "watch" with no name but only one mission
  if (!candidates.length) {
    const root = path.join(registryRoot, 'mega');
    if (!fs.existsSync(root)) return null;
    const active = fs.readdirSync(root).filter((n) => {
      if (n === 'archive' || n.startsWith('archive')) return false;
      return isMegaMission(registryRoot, n);
    });
    if (active.length === 1) return active[0];
  }
  // explicit name that is not a mega → null (caller may treat as error if intended)
  if (candidates.length) {
    return { missing: candidates[0] };
  }
  return null;
}

/** Best-effort task/dispatch snapshot for one sub-swarm workspace (null if none). */
function subswarmTaskSnapshot(registryRoot, swarmId) {
  if (!swarmId) return null;
  const ws = buildWorkspace(registryRoot, swarmId);
  if (!fs.existsSync(ws.root) || !fs.existsSync(ws.events)) return null;
  try {
    const st = dashboardState(ws);
    const active = (st.tasks || [])
      .filter((t) => ['building', 'review', 'planning', 'blocked'].includes(t.status))
      .map((t) => ({
        title: t.title,
        status: t.status,
        friendly: (st.friendlyStatus || {})[t.id] || t.status,
      }));
    const liveRuns = (st.runningDispatches || []).map((r) => ({
      agent: r.agentLabel || '?',
      title: r.taskTitle || r.taskId,
      elapsedMs: r.elapsedMs,
      pidAlive: r.pidAlive,
      worktree: r.worktree,
    }));
    return {
      done: st.stats ? st.stats.done : 0,
      total: st.stats ? st.stats.total : 0,
      pct: st.stats ? st.stats.pct : 0,
      building: (st.stats && st.stats.counts && st.stats.counts.building) || 0,
      review: (st.stats && st.stats.counts && st.stats.counts.review) || 0,
      blocked: (st.stats && st.stats.counts && st.stats.counts.blocked) || 0,
      live: st.stats ? st.stats.runningDispatches : 0,
      active,
      liveRuns,
    };
  } catch {
    return null;
  }
}

function summarizeLeaseFiles(files, max = 5) {
  if (!files || !files.length) return '';
  const short = files.map((f) => {
    const cleaned = String(f).replace(/\/\*\*$/, '').replace(/\/$/, '');
    const parts = cleaned.split('/').filter(Boolean);
    return parts[parts.length - 1] || cleaned;
  });
  if (short.length <= max) return short.join(', ');
  return short.slice(0, max).join(', ') + ' +' + (short.length - max);
}

function shortSwarmId(swarmId, megaId) {
  if (!swarmId) return '?';
  const prefix = megaId + '-';
  if (swarmId.startsWith(prefix)) return swarmId.slice(prefix.length);
  return swarmId;
}

function megaStatusStyle(status) {
  const s = String(status || '?').toLowerCase();
  if (s === 'running') return { icon: '●', code: '1;32', label: 'RUNNING' };
  if (s === 'done' || s === 'completed') return { icon: '✓', code: '1;32', label: s.toUpperCase() };
  if (s === 'queued') return { icon: '○', code: '1;33', label: 'QUEUED' };
  if (s === 'planned') return { icon: '··', code: '2', label: 'PLANNED' };
  if (s === 'failed' || s === 'blocked') return { icon: '✗', code: '1;31', label: s.toUpperCase() };
  if (s === 'cancelled') return { icon: '–', code: '2', label: 'CANCELLED' };
  if (s === 'review' || s === 'visual') return { icon: '◎', code: '1;36', label: s.toUpperCase() };
  return { icon: '·', code: '0', label: String(status || '?').toUpperCase() };
}

function progressBar(pct, width, color) {
  const w = Math.max(8, width | 0);
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const filled = Math.round((p / 100) * w);
  const bar = '█'.repeat(filled) + '░'.repeat(w - filled);
  return ansi('36', bar, color) + ' ' + ansi('1', p + '%', color);
}

/**
 * Pretty mega mission board (TTY + plain snapshot).
 * Groups subswarms, shows task progress when workspace exists, short coordinator lines.
 */
function renderMegaWatchScreen(megaId, state, plan, coordinators, opts) {
  const color = opts.color !== false;
  const compact = opts.compact === true;
  const cols = opts.columns || process.stdout.columns || 100;
  const registryRoot = opts.registryRoot;
  const lines = [];
  const push = (s) => lines.push(s);
  const now = Date.now();

  const megaSt = megaStatusStyle(state && state.status);
  const repoName = path.basename(path.dirname(opts.registryRoot || ''));
  push(
    ansi('1;36', 'MEGA', color) +
      ansi('2', ' · ' + (repoName || '?'), color) +
      '  ' +
      ansi('1', megaId, color) +
      '  ' +
      ansi(megaSt.code, megaSt.icon + ' ' + megaSt.label, color) +
      (opts.live ? ansi('1;32', '  LIVE', color) : ''),
  );

  if (state && state.goal) {
    push(ansi('2', truncate(state.goal, cols - 2), color));
  }
  push('');

  const subs = Object.values((state && state.subswarms) || {});
  const counts = { running: 0, queued: 0, planned: 0, done: 0, failed: 0, other: 0 };
  for (const s of subs) {
    const st = String(s.status || '').toLowerCase();
    if (st in counts) counts[st]++;
    else if (st === 'completed') counts.done++;
    else counts.other++;
  }
  const total = subs.length || 1;
  const doneN = counts.done;
  const pct = Math.round((doneN / total) * 100);
  const barW = Math.min(28, Math.max(12, Math.floor(cols / 3)));
  push(
    progressBar(pct, barW, color) +
      '  ' +
      ansi('1', doneN + '/' + total, color) +
      ' done' +
      ansi('2', '  ·  ', color) +
      ansi('32', counts.running + ' running', color) +
      ansi('2', '  ·  ', color) +
      ansi('33', counts.queued + ' queued', color) +
      ansi('2', '  ·  ', color) +
      ansi('2', counts.planned + ' planned', color) +
      (counts.failed ? ansi('31', '  ·  ' + counts.failed + ' failed', color) : ''),
  );

  const cap = (state && state.capacity) || (plan && plan.capacity) || {};
  const aliveCoords = (coordinators || []).length;
  const maxCoords = cap.max_coordinators != null ? cap.max_coordinators : '?';
  push(
    ansi('2', 'capacity', color) +
      '  builders≤' +
      (cap.max_builders != null ? cap.max_builders : '?') +
      '  coordinators ' +
      aliveCoords +
      '/' +
      maxCoords +
      (cap.max_visual_reviewers != null ? '  visual≤' + cap.max_visual_reviewers : ''),
  );
  if (opts.hostMemory) {
    const hm = opts.hostMemory;
    const memColor = hm.low ? '1;31' : '2';
    push(ansi(memColor, (hm.low ? '⚠ ' : '') + (hm.line || hostStats.formatMemoryLine(hm)) +
      (hm.autoPaused ? '  [AUTO-PAUSED]' : '') +
      '  (auto-kill < ' + (hm.minFreeGb || 2) + 'G avail)', color));
  }
  if (state && state.integrate_branch) {
    push(
      ansi('2', 'integrate', color) +
        '  ' +
        truncate(state.integrate_branch, Math.floor(cols * 0.55)) +
        ansi('2', ' → ' + (state.default_branch || 'master'), color),
    );
  }
  push('');

  const order = ['running', 'review', 'queued', 'planned', 'done', 'completed', 'failed', 'blocked', 'cancelled'];
  const byStatus = new Map();
  for (const s of subs) {
    const key = String(s.status || 'unknown').toLowerCase();
    if (!byStatus.has(key)) byStatus.set(key, []);
    byStatus.get(key).push(s);
  }
  // stable name sort within each group
  for (const arr of byStatus.values()) {
    arr.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  }
  const seen = new Set();
  const sectionKeys = [];
  for (const k of order) {
    if (byStatus.has(k)) {
      sectionKeys.push(k);
      seen.add(k);
    }
  }
  for (const k of byStatus.keys()) {
    if (!seen.has(k)) sectionKeys.push(k);
  }

  const sectionTitle = {
    running: 'RUNNING',
    review: 'REVIEW',
    queued: 'QUEUED',
    planned: 'PLANNED',
    done: 'DONE',
    completed: 'DONE',
    failed: 'FAILED',
    blocked: 'BLOCKED',
    cancelled: 'CANCELLED',
  };

  for (const key of sectionKeys) {
    const group = byStatus.get(key) || [];
    if (!group.length) continue;
    const sty = megaStatusStyle(key);
    push(
      ansi('1', sectionTitle[key] || key.toUpperCase(), color) +
        ansi('2', ' (' + group.length + ')', color),
    );
    for (const s of group) {
      const name = s.name || s.swarmId || '?';
      const nameW = Math.min(42, Math.max(24, cols - 48));
      let elapsed = '';
      if (s.startedAt && (key === 'running' || key === 'review')) {
        elapsed = '  ' + formatDuration(now - s.startedAt);
      } else if (s.startedAt && s.finishedAt) {
        elapsed = '  ' + formatDuration(s.finishedAt - s.startedAt);
      }
      const meta = [
        s.builders != null ? s.builders + 'b' : null,
        s.visual_review ? 'visual' : null,
        s.floor ? 'floor' : null,
      ]
        .filter(Boolean)
        .join(' · ');
      push(
        '  ' +
          ansi(sty.code, sty.icon, color) +
          ' ' +
          ansi(key === 'running' ? '1' : '0', truncate(name, nameW), color) +
          (meta ? ansi('2', '  ' + meta, color) : '') +
          ansi('2', elapsed, color),
      );

      if (!compact) {
        const tasks = subswarmTaskSnapshot(registryRoot, s.swarmId);
        if (tasks && tasks.total > 0) {
          const bits = [
            tasks.done + '/' + tasks.total + ' tasks',
            tasks.building ? 'building:' + tasks.building : null,
            tasks.review ? 'review:' + tasks.review : null,
            tasks.blocked ? 'blocked:' + tasks.blocked : null,
            tasks.live ? 'live:' + tasks.live : null,
          ].filter(Boolean);
          push(ansi('2', '      ' + bits.join('  ·  '), color));
          if (tasks.liveRuns && tasks.liveRuns.length) {
            for (const r of tasks.liveRuns.slice(0, 2)) {
              const dead = r.pidAlive === false ? ansi('31', '  (exited?)', color) : '';
              push(
                ansi(
                  '34',
                  '      ▶ ' +
                    truncate((r.agent || '?') + ' · ' + (r.title || ''), cols - 14) +
                    '  ' +
                    formatDuration(r.elapsedMs),
                  color,
                ) + dead,
              );
            }
          } else if (tasks.active && tasks.active.length) {
            for (const t of tasks.active.slice(0, 2)) {
              push(ansi('34', '      · ' + truncate(t.friendly || t.title, cols - 12), color));
            }
          }
        }
        const files = summarizeLeaseFiles(s.files, compact ? 3 : 5);
        if (files) push(ansi('2', '      files  ' + truncate(files, cols - 14), color));
        if (s.depends_on && s.depends_on.length) {
          const pending = s.depends_on.filter((d) => {
            const dep = state.subswarms && state.subswarms[d];
            const st = dep && String(dep.status || '').toLowerCase();
            return st !== 'done' && st !== 'completed';
          });
          if (pending.length) {
            push(
              ansi(
                '2',
                '      waits  ' +
                  pending.length +
                  ' dep' +
                  (pending.length === 1 ? '' : 's') +
                  (pending.length <= 3 ? ' (' + pending.join(', ') + ')' : ''),
                color,
              ),
            );
          }
        }
        if (s.note) push(ansi('33', '      note   ' + truncate(s.note, cols - 14), color));
      }
    }
    push('');
  }

  // Coordinators
  push(ansi('1', 'COORDINATORS', color) + ansi('2', ' (' + aliveCoords + ' alive)', color));
  if (!aliveCoords) {
    push(ansi('2', '  (none running)', color));
  } else {
    // map swarmId → short label; prefer matching mega subswarm names
    for (const rec of coordinators) {
      const sid = rec.swarmId || '?';
      const short = shortSwarmId(sid, megaId);
      const logBase = rec.logFile ? path.basename(rec.logFile) : '—';
      push(
        '  ' +
          ansi('32', '●', color) +
          ' ' +
          truncate(short, Math.min(40, cols - 36)) +
          ansi('2', '  pid ' + rec.pid, color) +
          ansi('2', '  ' + (rec.mode || '—'), color) +
          ansi('2', '  ' + logBase, color),
      );
    }
  }

  if (opts.live) {
    push('');
    push(ansi('2', 'Ctrl-C to exit · refreshes every ' + (opts.intervalSec || 2) + 's', color));
  } else if (!compact) {
    push('');
    push(ansi('2', 'tip: swarm watch ' + megaId + ' --loop   ·   --compact   ·   --json', color));
  }

  return lines.join('\n');
}

/**
 * One snapshot: pretty mega board + coordinators (the common human/agent poll).
 * Exit 0 when the mega mission exists; coordinator emptiness does not fail the command.
 */
function printMegaWatchSnapshot(args, megaId, registryRoot, snapOpts) {
  const jsonOut = args.json === 'true';
  const wantColor =
    args['no-color'] !== 'true' &&
    process.env.NO_COLOR == null &&
    (process.stdout.isTTY || process.env.FORCE_COLOR === '1');
  const compact = args.compact === 'true';
  const live = !!(snapOpts && snapOpts.live);
  const dir = megaMissionDir(registryRoot, megaId);
  let state = null;
  let plan = null;
  try {
    state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  } catch { /* absent */ }
  try {
    plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
  } catch { /* absent */ }
  const coordinators = listRunningCoordinators(registryRoot);
  let runningCoords = 0;
  for (const name of Object.keys((state && state.subswarms) || {})) {
    if (state.subswarms[name].status === 'running') runningCoords++;
  }

  // Enrich subswarms with task snapshots for JSON consumers
  const subswarmsOut = {};
  for (const [name, s] of Object.entries((state && state.subswarms) || {})) {
    const tasks = subswarmTaskSnapshot(registryRoot, s.swarmId);
    subswarmsOut[name] = tasks ? { ...s, tasks } : { ...s };
  }

  if (jsonOut) {
    console.log(
      JSON.stringify(
        {
          megaId,
          status: state && state.status,
          goal: state && state.goal,
          integrate_branch: state && state.integrate_branch,
          default_branch: state && state.default_branch,
          capacity: state && state.capacity,
          running_coordinators: runningCoords,
          progress: {
            done: Object.values(subswarmsOut).filter((s) =>
              ['done', 'completed'].includes(String(s.status || '').toLowerCase()),
            ).length,
            total: Object.keys(subswarmsOut).length,
            running: Object.values(subswarmsOut).filter(
              (s) => String(s.status || '').toLowerCase() === 'running',
            ).length,
            queued: Object.values(subswarmsOut).filter(
              (s) => String(s.status || '').toLowerCase() === 'queued',
            ).length,
          },
          subswarms: subswarmsOut,
          plan: plan && {
            capacity: plan.capacity,
            integrate_branch: plan.integrate_branch,
          },
          coordinators,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!state) {
    console.log('No mega state for ' + megaId);
    return;
  }

  const hostGuard = maybeAutoPauseLowMemory(registryRoot);
  const frame = renderMegaWatchScreen(megaId, state, plan, coordinators, {
    hostMemory: hostGuard.mem,
    color: wantColor,
    compact,
    columns: process.stdout.columns || 100,
    registryRoot,
    live,
    intervalSec: Number(args.interval) || 2,
  });
  console.log(frame);
}

function watchMegaCommand(args, megaId, registryRoot) {
  const intervalMs = Math.max(500, (Number(args.interval) || 2) * 1000);
  const jsonOut = args.json === 'true';
  const isTty = process.stdout.isTTY;
  // Mega watch defaults to one snapshot (agent-friendly). Live loop only on TTY without --once.
  const onceMode = args.once === 'true' || jsonOut || !isTty || args.loop !== 'true';

  const tick = () => {
    if (isTty && !onceMode) {
      process.stdout.write('\x1b[2J\x1b[H');
    }
    printMegaWatchSnapshot(args, megaId, registryRoot, { live: !onceMode });
  };

  if (onceMode) {
    tick();
    return;
  }

  process.stdout.write('\x1b[?25l');
  const cleanup = () => {
    process.stdout.write('\x1b[?25h\n');
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  tick();
  setInterval(tick, intervalMs);
}

function renderWatchScreen(state, opts) {
  const color = opts.color !== false;
  const compact = opts.compact === true;
  const cols = opts.columns || 80;
  const lines = [];
  const push = (s) => lines.push(s);
  if (state && !state.hostMemory && opts && opts.registryRoot) {
    try {
      const g = maybeAutoPauseLowMemory(opts.registryRoot);
      state.hostMemory = g.mem;
      state.memoryGuard = { triggered: g.triggered, skipped: g.skipped || null };
    } catch { /* noop */ }
  } else if (state && !state.hostMemory) {
    try { state.hostMemory = hostStats.hostMemoryPayload(); } catch { /* noop */ }
  }

  push(ansi('1;36', 'Grok Swarm', color) + ansi('2', ' · ' + (state.repoName || '?'), color) +
    (state.swarmId ? ansi('2', ' · ' + state.swarmId, color) : '') +
    ansi('1;32', '  LIVE ●', color));
  if (state.hostMemory) {
    const hm = state.hostMemory;
    const memColor = hm.low ? '1;31' : (hm.availableGb < (hm.minFreeGb || 2) * 1.5 ? '1;33' : '2');
    push(ansi(memColor, (hm.low ? '⚠ ' : '') + (hm.line || hostStats.formatMemoryLine(hm)) +
      (hm.autoPaused ? '  [AUTO-PAUSED]' : '') +
      '  (kill if avail < ' + (hm.minFreeGb || 2) + 'G)', color));
  }
  if (state.goal) push(truncate(state.goal.title, cols - 4));
  if (state.paused) {
    const n = (state.paused.interrupted || []).length;
    push(ansi('1;33', '[PAUSED]' + (state.paused.reason ? ' ' + state.paused.reason : '') +
      (n ? ' — ' + n + ' interrupted run(s)' : ''), color));
  }
  if (state.boardHealth && !state.boardHealth.ok) {
    for (const p of (state.boardHealth.problems || []).slice(0, 3)) {
      push(ansi('1;31', '[health] ' + p.message, color));
    }
  }
  push('');
  const pct = state.stats ? state.stats.pct : 0;
  const done = state.stats ? state.stats.done : 0;
  const total = state.stats ? state.stats.total : 0;
  const barW = Math.min(24, Math.max(10, Math.floor(cols / 4)));
  const filled = Math.round((pct / 100) * barW);
  push('[' + '#'.repeat(filled) + '-'.repeat(barW - filled) + '] ' + pct + '%  ' + done + '/' + total + ' done' +
    (state.stats ? '  building:' + (state.stats.counts.building || 0) +
      '  queued:' + ((state.stats.counts.open || 0) + (state.stats.counts.assigned || 0)) +
      '  live:' + state.stats.runningDispatches : ''));
  if (state.eta && state.eta.estimatedMsLeft) {
    push(ansi('2', '  eta ~' + formatDuration(state.eta.estimatedMsLeft), color));
  }
  push('');
  push(ansi('1', 'HAPPENING NOW', color));
  const active = (state.tasks || []).filter((t) =>
    ['planning', 'building', 'review', 'blocked'].includes(t.status));
  if (!active.length) push(ansi('2', '  (nothing in flight)', color));
  for (const t of active) {
    const friendly = (state.friendlyStatus || {})[t.id] || t.status;
    push('  ' + truncate(t.title, cols - 6));
    push(ansi('34', '    ' + friendly, color));
    if (!compact && t.ownedFiles && t.ownedFiles.length) {
      push(ansi('2', '    files: ' + truncate(t.ownedFiles.join(', '), cols - 12), color));
    }
  }
  push('');
  push(ansi('1', 'UP NEXT', color));
  const upnext = (state.tasks || []).filter((t) => t.status === 'open' || t.status === 'assigned').slice(0, compact ? 3 : 5);
  if (!upnext.length) push(ansi('2', '  (nothing queued)', color));
  for (const t of upnext) {
    push('  ' + truncate(t.title, cols - 6) + ansi('2', ' — ' + ((state.friendlyStatus || {})[t.id] || ''), color));
  }
  push('');
  const doneN = (state.tasks || []).filter((t) => t.status === 'done').length;
  const recent = state.recentDone || [];
  push(ansi('1', 'DONE (' + doneN + ')', color) + (recent.length
    ? ' — ' + recent.map((t) => truncate(t.title, 28)).join(', ')
    : ''));
  if ((state.runningDispatches || []).length) {
    push('');
    push(ansi('1', 'LIVE RUNS', color));
    for (const r of state.runningDispatches) {
      push('  ▶ ' + (r.agentLabel || '?') + ' · ' + truncate(r.taskTitle || r.taskId, cols - 20) +
        '  ' + formatDuration(r.elapsedMs));
      if (r.worktree) push(ansi('2', '    wt: ' + r.worktree, color));
      if (r.pidAlive === false) push(ansi('31', '    (process may have exited)', color));
      if (opts.tailLog && r.logFile) {
        const tail = readLogTail(state._ws, r.id, { lines: opts.tailLog, format: 'plain' });
        for (const line of (tail.lines || []).slice(-opts.tailLog)) {
          const plain = parseStreamingJsonLine(line);
          const text = plain.data || line;
          push(ansi('3', '    ' + truncate(text, cols - 6), color));
        }
      }
    }
  }
  if (!compact && state.activityFeed && state.activityFeed.length) {
    push('');
    push(ansi('1', 'ACTIVITY', color));
    for (const ev of state.activityFeed.slice(0, 5)) {
      push(ansi('2', '  ' + truncate((ev.agentLabel || '?') + ': ' + ev.text, cols - 4), color));
    }
  }
  push('');
  push(ansi('2', 'Ctrl-C to exit · refreshes every ' + (opts.intervalSec || 2) + 's', color));
  return lines.join('\n');
}

function watchCommand(argv) {
  const args = parseArgs(argv);
  // Mega shortcut: `swarm watch <mega-id>` ≡ pretty mega board + coordinators
  // (also: swarm watch --id <mega-id>, swarm mega watch --id <mega-id>)
  // Explicit --swarm / --all skips mega auto-pick so single-swarm boards still work mid-mega.
  const registryRootForMega = resolveWatchRegistryRoot(args, { required: false });
  const forceSingleSwarm =
    (args.swarm && args.swarm !== 'true') || args.all === 'true';
  if (registryRootForMega && !forceSingleSwarm) {
    const megaResolved = resolveWatchMegaId(args, registryRootForMega);
    if (typeof megaResolved === 'string') {
      watchMegaCommand(args, megaResolved, registryRootForMega);
      return;
    }
    if (megaResolved && megaResolved.missing) {
      // Only error when the user clearly asked for a named mega (positional / --id)
      const asked =
        (args.id && args.id !== 'true') ||
        (args._ &&
          args._.some(
            (p) => p && !String(p).startsWith('-') && p !== 'status' && p !== 'watch',
          ));
      if (asked) {
        die(
          'No mega mission "' +
            megaResolved.missing +
            '" under ' +
            path.join(registryRootForMega, 'mega') +
            '.\n' +
            'List: swarm mega status --repo ' +
            path.dirname(registryRootForMega) +
            '\n' +
            'Or live single-swarm board: swarm watch --swarm <id> --once',
        );
      }
    }
  }

  const intervalMs = Math.max(500, (Number(args.interval) || 2) * 1000);
  const jsonOut = args.json === 'true';
  const color = args['no-color'] !== 'true';
  const compact = args.compact === 'true';
  const tailLog = args['tail-log'] && args['tail-log'] !== 'true' ? Number(args['tail-log']) : 0;
  const isTty = process.stdout.isTTY;

  // Pass --repo through as cwd for single-swarm watch resolution
  if (args.repo && args.repo !== 'true' && (!args.cwd || args.cwd === 'true')) {
    args.cwd = args.repo;
  }

  const renderAll = () => {
    const ctx = resolveWatchWorkspace(args);
    if (ctx.mode === 'all') {
      const parts = [];
      for (const s of ctx.registry.swarms) {
        const ws = buildWorkspace(ctx.registryRoot, s.id);
        const st = dashboardState(ws);
        st._ws = ws;
        parts.push('=== ' + s.id + ' ===\n' + renderWatchScreen(st, { color, compact, columns: process.stdout.columns || 80, tailLog, intervalSec: intervalMs / 1000, registryRoot: requireRegistryRoot(args) }));
      }
      return parts.join('\n\n');
    }
    const st = dashboardState(ctx.ws);
    st._ws = ctx.ws;
    return renderWatchScreen(st, { color, compact, columns: process.stdout.columns || 80, tailLog, intervalSec: intervalMs / 1000, registryRoot: requireRegistryRoot(args) });
  };

  const tick = () => {
    const ctx = resolveWatchWorkspace(args);
    if (jsonOut) {
      if (ctx.mode === 'all') {
        console.log(JSON.stringify(dashboardOverviewState(ctx.registryRoot), null, 2));
      } else {
        console.log(JSON.stringify(dashboardState(ctx.ws), null, 2));
      }
      return;
    }
    const frame = renderAll();
    if (isTty && !onceMode) {
      process.stdout.write('\x1b[2J\x1b[H' + frame);
    } else {
      console.log(frame);
    }
  };

  const onceMode = args.once === 'true' || (!isTty && !jsonOut);

  if (onceMode || jsonOut) {
    tick();
    return;
  }

  process.stdout.write('\x1b[?25l');
  const cleanup = () => {
    process.stdout.write('\x1b[?25h\n');
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  tick();
  setInterval(tick, intervalMs);
}

function openInBrowser(url) {
  const { spawn } = require('child_process');
  const attempts = process.platform === 'darwin'
    ? [['open', ['-a', 'Google Chrome', url]], ['open', [url]]]
    : [['xdg-open', [url]]];
  const tryNext = (i) => {
    if (i >= attempts.length) return;
    const [cmd, cmdArgs] = attempts[i];
    const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true });
    child.on('error', () => tryNext(i + 1));
    child.on('exit', (code) => { if (code !== 0) tryNext(i + 1); });
    child.unref();
  };
  tryNext(0);
}

function dashboardPidFile(registryRoot) {
  return path.join(registryRoot, 'dashboard.pid');
}

/**
 * Blocking 100ms poll for the daemon child's own pidfile. The child writes it
 * from inside the listen() callback, so its appearance (with a live pid) is the
 * only honest proof of a real bind — spawn() succeeding is not.
 */
function waitForDashboardBind(registryRoot, timeoutMs) {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rec = readDashboardPid(registryRoot);
    if (rec) return rec;
    if (Date.now() >= deadline) return null;
    Atomics.wait(sleeper, 0, 0, 100);
  }
}

function tailLines(file, n) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l !== '');
    return lines.slice(-n).join('\n') || '(log empty)';
  } catch {
    return '(log unreadable: ' + file + ')';
  }
}

function readDashboardPid(registryRoot) {
  const file = dashboardPidFile(registryRoot);
  if (!fs.existsSync(file)) return null;
  try {
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!rec || !rec.pid) return null;
    try {
      process.kill(rec.pid, 0); // liveness probe
      return rec;
    } catch {
      return null; // stale pidfile
    }
  } catch {
    return null;
  }
}

function exposeDashboardOnTailscale(port) {
  // Best-effort: the dashboard binds 127.0.0.1 only, so publish it on the
  // tailnet via `tailscale serve` (idempotent, per-port HTTPS). Returns the
  // https URL, or null when tailscale is absent/down (dashboard stays local).
  const { execSync } = require('child_process');
  const sh = (cmd, opts) => execSync(cmd, Object.assign({ shell: '/bin/sh', timeout: 10000 }, opts));
  let bin = null;
  for (const cand of ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
    try {
      sh(cand === 'tailscale' ? 'command -v tailscale' : 'test -x "' + cand + '"', { stdio: 'ignore' });
      bin = cand; break;
    } catch { /* next candidate */ }
  }
  if (!bin) return null;
  try {
    sh('"' + bin + '" serve --bg --https=' + Number(port) + ' ' + Number(port), { stdio: 'ignore' });
    const st = JSON.parse(sh('"' + bin + '" status --json', { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
    const dns = ((st.Self && st.Self.DNSName) || '').replace(/\.$/, '');
    if (dns) return 'https://' + dns + ':' + Number(port) + '/';
  } catch { /* tailscale down or logged out */ }
  return null;
}

function dashboardCommand(argv) {
  const args = parseArgs(argv);
  const registryRoot = requireRegistryRoot(args);
  const repoRoot = path.dirname(registryRoot);
  const sub = args._[0];

  if (sub === 'stop') {
    const rec = readDashboardPid(registryRoot);
    if (!rec) {
      try { fs.unlinkSync(dashboardPidFile(registryRoot)); } catch { /* noop */ }
      console.log('No running dashboard (pidfile absent or stale).');
      return;
    }
    try { process.kill(rec.pid, 'SIGTERM'); } catch { /* already gone */ }
    try { fs.unlinkSync(dashboardPidFile(registryRoot)); } catch { /* noop */ }
    console.log('Stopped dashboard (pid ' + rec.pid + ').');
    return;
  }

  if (sub === 'status') {
    const rec = readDashboardPid(registryRoot);
    if (rec) {
      console.log('Dashboard running: pid ' + rec.pid + ' — http://127.0.0.1:' + rec.port + '/  (log: ' + (rec.logFile || '—') + ')');
      const tsUrl = exposeDashboardOnTailscale(rec.port);
      if (tsUrl) console.log('Tailscale: ' + tsUrl);
    } else {
      console.log('Dashboard not running.');
    }
    process.exitCode = rec ? 0 : 1;
    return;
  }

  if (args.daemon === 'true') {
    const existing = readDashboardPid(registryRoot);
    if (existing) {
      console.log('Dashboard already running: pid ' + existing.pid + ' — http://127.0.0.1:' + existing.port + '/');
      const tsExisting = exposeDashboardOnTailscale(existing.port);
      if (tsExisting) console.log('Tailscale: ' + tsExisting);
      if (args.open === 'true') openInBrowser('http://127.0.0.1:' + existing.port + '/');
      return;
    }
    const { spawn } = require('child_process');
    const port = args.port && args.port !== 'true' ? Number(args.port) : 4599;
    const logFile = path.join(registryRoot, 'dashboard.log');
    const logFd = fs.openSync(logFile, 'a');
    const childArgs = [__filename, 'dashboard', '--port', String(port), '--_daemon-child', '--cwd', repoRoot];
    // A stale (dead-pid) pidfile from a previous run must not be mistaken for
    // this child's bind proof below.
    try { fs.unlinkSync(dashboardPidFile(registryRoot)); } catch { /* none */ }
    const child = spawn(process.execPath, childArgs, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    fs.closeSync(logFd);
    // spawn() success is NOT server-up: an EADDRINUSE bind dies to dashboard.log
    // long after we would have printed "started" and written a pidfile for a
    // process that is already gone. The child writes dashboard.pid itself once
    // listen() succeeds — wait for that, or report the log and fail loudly.
    const rec = waitForDashboardBind(registryRoot, 2000);
    if (!rec) {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
      console.error('Dashboard failed to bind 127.0.0.1:' + port + ' within 2s — tail of ' + logFile + ':');
      console.error(tailLines(logFile, 12));
      process.exitCode = 1;
      return;
    }
    const url = 'http://127.0.0.1:' + rec.port + '/';
    console.log('Dashboard daemon started: pid ' + rec.pid + ' — ' + url + '  (log: ' + logFile + ')');
    console.log('Stop with: swarm dashboard stop');
    const tsUrl = exposeDashboardOnTailscale(rec.port);
    if (tsUrl) console.log('Tailscale: ' + tsUrl);
    if (args.open === 'true') openInBrowser(url);
    return;
  }

  const http = require('http');
  const port = args.port && args.port !== 'true' ? Number(args.port) : 4599;

  const dashboardControl = require('./dashboard-control.cjs');
  const server = http.createServer((req, res) => {
    const chunks = [];
    let bodyLen = 0;
    req.on('data', (c) => { bodyLen += c.length; if (bodyLen <= 64 * 1024 + 1) chunks.push(c); });
    req.on('end', () => handleRequest(req, res, Buffer.concat(chunks).toString('utf8')));
  });

  function handleRequest(req, res, body) {
    const parsed = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = parsed.pathname;
    const view = parsed.searchParams.get('view');
    const swarmParam = parsed.searchParams.get('swarm');
    const dispatchParam = parsed.searchParams.get('dispatch');

    // resolveSwarmId() is a CLI helper that die()s (process.exit) on unknown
    // ids — inside the HTTP server that kills the daemon on any bad ?swarm=
    // param (stale browser tab with swarm=overview in localStorage = crash
    // loop). Resolve without ever exiting; throw instead so handlers 4xx.
    const resolveSwarmIdHttp = (registry, param) => {
      if (param && registry.swarms.some((s) => s.id === param)) return param;
      if (param) {
        throw new Error('Unknown swarm "' + param + '". Registered: ' +
          (registry.swarms.map((s) => s.id).join(', ') || '(none)'));
      }
      if (registry.swarms.length === 1) return registry.swarms[0].id;
      if (registry.default && registry.swarms.some((s) => s.id === registry.default)) return registry.default;
      throw new Error('No swarm selected and no default registered');
    };

    try {
      if (dashboardControl.handleControlRequest({
        registryRoot, repoRoot, swarmCjs: __filename,
        ensureRegistry, resolveSwarmIdHttp, buildWorkspace, readCoordinatorPid, readAgents,
      }, req, res, body)) return;
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
      return;
    }

    if (pathname === '/api/swarms') {
      const registry = ensureRegistry(registryRoot);
      // Enrich each pack with live progress so the UI can hide completed/paused packs
      // (dashboard mission-root filter — 2026-08-07).
      const swarms = (registry.swarms || []).map((s) => {
        const row = { ...s };
        try {
          const ws = buildWorkspace(registryRoot, s.id);
          const st = dashboardState(ws);
          row.stats = {
            done: (st.stats && st.stats.done) || 0,
            total: (st.stats && st.stats.total) || 0,
            counts: (st.stats && st.stats.counts) || {},
          };
          row.paused = !!(st.paused);
          if (st.paused) row.status = 'paused';
          else if (row.stats.total > 0 && row.stats.done >= row.stats.total) row.status = 'done';
          else if (row.status !== 'active') row.status = row.status || 'active';
        } catch {
          /* leave bare registry row */
        }
        return row;
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        default: registry.default,
        swarms,
        repoName: path.basename(repoRoot),
      }));
      return;
    }

    if (pathname === '/api/log-tail') {
      try {
        const registry = ensureRegistry(registryRoot);
        const swarmId = resolveSwarmIdHttp(registry, swarmParam);
        const ws = buildWorkspace(registryRoot, swarmId);
        const lines = Number(parsed.searchParams.get('lines') || '80');
        const format = parsed.searchParams.get('format') || 'plain';
        const payload = readLogTail(ws, dispatchParam, { lines, format });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err && err.message || err) }));
      }
      return;
    }

    // Live feed: what the coordinator and running builders are DOING right now
    // (parsed streaming-json thoughts/tool calls), not just board transitions.
    if (pathname === '/api/activity') {
      try {
        const registry = ensureRegistry(registryRoot);
        const swarmId = resolveSwarmIdHttp(registry, swarmParam);
        const ws = buildWorkspace(registryRoot, swarmId);
        const cap = Math.max(1, Math.min(Number(parsed.searchParams.get('lines') || '14'), LOG_TAIL_MAX_LINES));
        const coordLog = coordinatorLogFile(registryRoot, swarmId);
        const coordPid = readCoordinatorPid(registryRoot, swarmId);
        let coordMtime = 0;
        try { coordMtime = fs.statSync(coordLog).mtimeMs; } catch { /* no log yet */ }
        const runs = [];
        try {
          for (const f of fs.readdirSync(ws.dispatches)) {
            if (!f.endsWith('.json')) continue;
            let rec;
            try { rec = JSON.parse(fs.readFileSync(path.join(ws.dispatches, f), 'utf8')); } catch { continue; }
            if (!rec || rec.status !== 'running') continue;
            let mtime = 0;
            try { mtime = fs.statSync(rec.logFile).mtimeMs; } catch { /* gone */ }
            runs.push({
              id: rec.id,
              agent: rec.agentLabel || rec.agent || 'agent',
              taskId: rec.taskId || null,
              logMtime: mtime,
              events: tailStreamEvents(rec.logFile, 4),
            });
          }
        } catch { /* no dispatches dir */ }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
          swarmId,
          coordinator: {
            alive: !!coordPid,
            logMtime: coordMtime,
            events: tailStreamEvents(coordLog, cap),
          },
          runs,
          now: Date.now(),
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err && err.message || err) }));
      }
      return;
    }

    if (pathname === '/api/mega' || (pathname === '/api/state' && view === 'mega')) {
      try {
        const megaRt = require('./mega-runtime.cjs');
        const megaParam = parsed.searchParams.get('id') || parsed.searchParams.get('mega');
        const ids = megaRt.listMegas(registryRoot);
        if (!megaParam || megaParam === 'all') {
          const body = attachHostMemory({
            megas: ids.map((id) => megaRt.megaStatePayload(registryRoot, id)),
            repoName: path.basename(repoRoot),
          }, registryRoot);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(body));
          return;
        }
        if (!ids.includes(megaParam) && !fs.existsSync(path.join(registryRoot, 'mega', megaParam, 'plan.json'))) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'mega not found: ' + megaParam }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(megaRt.megaStatePayload(registryRoot, megaParam)));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err && err.message || err) }));
      }
      return;
    }

    if (pathname === '/api/state') {
      let payload;
      try {
        // "overview"/"__all__" as a swarm id are aliases for the overview view
        // (legacy clients persist them in localStorage prefs).
        if (view === 'overview' || swarmParam === 'overview' || swarmParam === '__all__') {
          payload = dashboardOverviewState(registryRoot);
        } else {
          const registry = ensureRegistry(registryRoot);
          const swarmId = resolveSwarmIdHttp(registry, swarmParam);
          const ws = buildWorkspace(registryRoot, swarmId);
          payload = dashboardState(ws);
        }
        payload = attachHostMemory(payload, registryRoot);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err && err.message || err) }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
      return;
    }

    if (pathname === '/api/host' || pathname === '/api/memory') {
      try {
        const payload = attachHostMemory({ ok: true }, registryRoot);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err && err.message || err) }));
      }
      return;
    }

    // Static mission-control assets (WebGL SPA)
    if (pathname === '/dashboard' || pathname.startsWith('/dashboard/')) {
      try {
        const dashRoot = path.join(path.dirname(__dirname), 'dashboard');
        let rel = pathname === '/dashboard' || pathname === '/dashboard/'
          ? 'index.html'
          : decodeURIComponent(pathname.slice('/dashboard/'.length));
        if (rel.includes('..') || path.isAbsolute(rel)) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('bad path');
          return;
        }
        const filePath = path.normalize(path.join(dashRoot, rel));
        if (!filePath.startsWith(path.normalize(dashRoot + path.sep)) && filePath !== path.normalize(dashRoot)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('forbidden');
          return;
        }
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('not found');
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const mime =
          ext === '.js' ? 'application/javascript; charset=utf-8' :
          ext === '.css' ? 'text/css; charset=utf-8' :
          ext === '.html' ? 'text/html; charset=utf-8' :
          ext === '.json' ? 'application/json; charset=utf-8' :
          ext === '.svg' ? 'image/svg+xml' :
          ext === '.png' ? 'image/png' :
          ext === '.frag' || ext === '.vert' || ext === '.glsl' ? 'text/plain; charset=utf-8' :
          'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': mime,
          'Cache-Control': 'no-store',
        });
        res.end(fs.readFileSync(filePath));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(String(err && err.message || err));
      }
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      const htmlFile = dashboardHtmlPath();
      if (!fs.existsSync(htmlFile)) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Missing dashboard template: ' + htmlFile);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(htmlFile, 'utf8'));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      die('Port ' + port + ' is already in use (another swarm dashboard?). Pass --port <n> or reuse the running one.');
    }
    die('Dashboard server error: ' + String(err && err.message || err));
  });

  server.listen(port, '127.0.0.1', () => {
    const actual = server.address().port;
    const url = 'http://127.0.0.1:' + actual + '/';
    // Bind confirmed — only now is the daemon real. The --daemon parent polls for
    // this file and refuses to report "started" without it (EADDRINUSE never gets
    // here, so no pidfile is left behind for a dead process).
    if (args['_daemon-child'] === 'true') {
      writeJsonPretty(dashboardPidFile(registryRoot), {
        pid: process.pid,
        port: actual,
        logFile: path.join(registryRoot, 'dashboard.log'),
        startedAt: Date.now(),
      });
    }
    console.log('Swarm dashboard: ' + url + '  (registry: ' + registryRoot + ')');
    console.log('Auto-refreshes every 2s from event state. Ctrl-C to stop.');
    const tsFg = exposeDashboardOnTailscale(actual);
    if (tsFg) console.log('Tailscale: ' + tsFg);
    if (args.open === 'true') openInBrowser(url);
  });
}

// ---------------------------------------------------------------------------
// autonomous Grok CLI coordinator daemon
// ---------------------------------------------------------------------------
function skillRootDir() {
  return path.dirname(__dirname);
}

/**
 * Per-swarm coordinator files. Mega launches N coordinators in parallel — a single
 * registry-root coordinator.pid made every launch after the first no-op ("already running").
 * Layout: .grok-swarm/swarms/<id>/coordinator.{pid,log,prompt.md}
 * Legacy fallback: .grok-swarm/coordinator.pid (default swarm only).
 */
function coordinatorPidFile(registryRoot, swarmId) {
  const sid = swarmId || 'default';
  return path.join(registryRoot, 'swarms', sid, 'coordinator.pid');
}

function coordinatorLogFile(registryRoot, swarmId) {
  return path.join(registryRoot, 'swarms', swarmId || 'default', 'coordinator.log');
}

function coordinatorPromptFile(registryRoot, swarmId) {
  return path.join(registryRoot, 'swarms', swarmId || 'default', 'coordinator-prompt.md');
}

function legacyCoordinatorPidFile(registryRoot) {
  return path.join(registryRoot, 'coordinator.pid');
}

function readCoordinatorPid(registryRoot, swarmId) {
  const sid = swarmId || 'default';
  const candidates = [coordinatorPidFile(registryRoot, sid)];
  if (sid === 'default') candidates.push(legacyCoordinatorPidFile(registryRoot));
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!rec || !rec.pid) continue;
      try {
        process.kill(rec.pid, 0);
        return rec;
      } catch {
        /* stale pidfile */
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function listRunningCoordinators(registryRoot) {
  const out = [];
  const swarmsDir = path.join(registryRoot, 'swarms');
  if (fs.existsSync(swarmsDir)) {
    for (const id of fs.readdirSync(swarmsDir)) {
      const rec = readCoordinatorPid(registryRoot, id);
      if (rec) out.push({ ...rec, swarmId: rec.swarmId || id });
    }
  }
  const legacy = readCoordinatorPid(registryRoot, 'default');
  if (legacy && !out.some((r) => r.pid === legacy.pid)) {
    out.push({ ...legacy, swarmId: legacy.swarmId || 'default' });
  }
  return out;
}

function renderCoordinatorPrompt(ws, opts) {
  const tplPath = templatePath('coordinator-prompt.md');
  if (!fs.existsSync(tplPath)) die('Missing template: ' + tplPath);
  let body = fs.readFileSync(tplPath, 'utf8');
  // Drop HTML comment header block from rendered prompt
  body = body.replace(/^<!--[\s\S]*?-->\s*/m, '');

  const state = readState(ws);
  const goal = (state.goals || []).find((g) => g.status === 'active') ||
    (state.goals || [])[0] ||
    { title: opts.goal || '(no goal set)' };
  const skillRoot = skillRootDir();
  const swarmBin = path.join(skillRoot, 'bin', 'swarm');
  const dispatchGrok = path.join(skillRoot, 'bin', 'dispatch-grok.sh');
  const guard = path.join(skillRoot, 'bin', 'coordinator-guard.sh');
  const builderTpl = path.join(skillRoot, 'templates', 'builder-prompt.md');
  const resume = !!opts.resume;
  const resumeOrFresh = resume ? 'RESUME' : 'FRESH';
  const resumeInstructions = resume
    ? [
        '**RESUME mode:** Do NOT re-init the workspace. Read existing `.grok-swarm/` events, dispatches, and worktrees.',
        'Reconcile running builders first. Each loop run `swarm tick --json` and do `next` in order.',
        'Do not lift a pause yourself. Hold and hard-pause both come from tick.',
      ].join('\n')
    : [
        '**FRESH mode:** Workspace and tasks should already exist (parent agent planned them).',
        'Do not recreate tasks. Start the main loop: dispatch ready tasks, monitor, verify, merge.',
      ].join('\n');

  const replacements = {
    REPO_PATH: ws.repoRoot,
    GOAL: goal.title || String(goal.id || 'primary'),
    SWARM_BIN: swarmBin,
    DISPATCH_GROK: dispatchGrok,
    COORDINATOR_GUARD: guard,
    BUILDER_PROMPT_TEMPLATE: builderTpl,
    SKILL_ROOT: skillRoot,
    SWARM_ID: ws.swarmId === 'default' ? '' : ws.swarmId,
    RESUME_OR_FRESH: resumeOrFresh,
    RESUME_OR_FRESH_INSTRUCTIONS: resumeInstructions,
  };
  for (const [key, val] of Object.entries(replacements)) {
    body = body.split('{{' + key + '}}').join(val == null ? '' : String(val));
  }
  return body;
}

function coordinatorCommand(argv) {
  const args = parseArgs(argv);
  const registryRoot = requireRegistryRoot(args);
  const repoRoot = path.dirname(registryRoot);
  const sub = args._[0];

  if (sub === 'stop') {
    // --all: stop every per-swarm coordinator
    if (args.all === 'true') {
      const all = listRunningCoordinators(registryRoot);
      for (const rec of all) {
        try { process.kill(rec.pid, 'SIGTERM'); } catch { /* noop */ }
        const sid = rec.swarmId || 'default';
        try { fs.unlinkSync(coordinatorPidFile(registryRoot, sid)); } catch { /* noop */ }
        try { fs.unlinkSync(legacyCoordinatorPidFile(registryRoot)); } catch { /* noop */ }
        console.log('Stopped coordinator swarm=' + sid + ' pid ' + rec.pid);
      }
      if (!all.length) console.log('No running coordinators.');
      return;
    }
    let swarmId;
    try {
      swarmId = resolveSwarmId(ensureRegistry(registryRoot), args);
    } catch {
      swarmId = args.swarm && args.swarm !== 'true' ? args.swarm : 'default';
    }
    const rec = readCoordinatorPid(registryRoot, swarmId);
    if (!rec) {
      try { fs.unlinkSync(coordinatorPidFile(registryRoot, swarmId)); } catch { /* noop */ }
      console.log('No running coordinator for swarm "' + swarmId + '" (pidfile absent or stale).');
      return;
    }
    try { process.kill(rec.pid, 'SIGTERM'); } catch { /* already gone */ }
    try { fs.unlinkSync(coordinatorPidFile(registryRoot, swarmId)); } catch { /* noop */ }
    if (swarmId === 'default') {
      try { fs.unlinkSync(legacyCoordinatorPidFile(registryRoot)); } catch { /* noop */ }
    }
    console.log('Stopped coordinator swarm=' + swarmId + ' (pid ' + rec.pid + ').');
    if (args['no-pause'] !== 'true') {
      try {
        const ws = buildWorkspace(registryRoot, swarmId);
        const running = readDispatches(ws).filter((d) => d.status === 'running');
        if (running.length > 0) {
          console.log('Hint: ' + running.length + ' builder dispatch(es) still running. Consider: swarm pause --swarm ' + swarmId);
        }
      } catch {
        /* workspace optional on stop */
      }
    }
    return;
  }

  if (sub === 'status') {
    if (args.all === 'true' || (!args.swarm && !process.env.SWARM_ID)) {
      const all = listRunningCoordinators(registryRoot);
      if (args.json === 'true') {
        console.log(JSON.stringify({ running: all.length, coordinators: all }, null, 2));
      } else if (!all.length) {
        console.log('No coordinators running.');
      } else {
        for (const rec of all) {
          console.log(
            'swarm=' + (rec.swarmId || '?') +
            '  pid ' + rec.pid +
            '  log: ' + (rec.logFile || '—') +
            '  mode: ' + (rec.mode || '—')
          );
        }
      }
      process.exitCode = all.length ? 0 : 1;
      return;
    }
    let swarmId;
    try {
      swarmId = resolveSwarmId(ensureRegistry(registryRoot), args);
    } catch {
      swarmId = args.swarm && args.swarm !== 'true' ? args.swarm : 'default';
    }
    const rec = readCoordinatorPid(registryRoot, swarmId);
    if (args.json === 'true') {
      console.log(JSON.stringify(rec || { running: false, swarmId }, null, 2));
      process.exitCode = rec ? 0 : 1;
      return;
    }
    if (rec) {
      console.log(
        'Coordinator running: swarm=' + swarmId +
        '  pid ' + rec.pid +
        '  log: ' + (rec.logFile || '—') +
        '  prompt: ' + (rec.promptFile || '—') +
        (rec.sessionId ? '  session: ' + rec.sessionId : '') +
        '  mode: ' + (rec.mode || '—')
      );
    } else {
      console.log('Coordinator not running for swarm "' + swarmId + '".');
    }
    process.exitCode = rec ? 0 : 1;
    return;
  }

  if (sub !== 'start' && sub !== undefined) {
    die('Usage: swarm coordinator start|status|stop ... (see: swarm help coordinator)');
  }
  // start (default when no sub or sub === start)
  if (sub === 'start' || sub === undefined) {
    /* fall through */
  }

  const registry = ensureRegistry(registryRoot);
  const swarmId = resolveSwarmId(registry, args);
  const ws = buildWorkspace(registryRoot, swarmId);
  if (!fs.existsSync(ws.root)) {
    die('Swarm "' + swarmId + '" missing. Run: swarm init ' + repoRoot);
  }

  const resume = args.resume === 'true';
  let sessionId = args.session && args.session !== 'true' ? args.session : null;
  if (resume && !sessionId) {
    const prev = readCoordinatorPid(registryRoot, swarmId) || (() => {
      const hist = path.join(registryRoot, 'swarms', swarmId, 'coordinator-history');
      const histLegacy = path.join(registryRoot, 'coordinator-history');
      for (const histDir of [hist, histLegacy]) {
        if (!fs.existsSync(histDir)) continue;
        const files = fs.readdirSync(histDir).filter((f) => f.endsWith('.json')).sort();
        if (!files.length) continue;
        try {
          const rec = JSON.parse(fs.readFileSync(path.join(histDir, files[files.length - 1]), 'utf8'));
          if (!rec.swarmId || rec.swarmId === swarmId) return rec;
        } catch {
          /* continue */
        }
      }
      return null;
    })();
    if (prev && prev.sessionId) sessionId = prev.sessionId;
  }

  const existing = readCoordinatorPid(registryRoot, swarmId);
  if (existing && args['print-only'] !== 'true') {
    console.log('Coordinator already running for swarm "' + swarmId + '": pid ' + existing.pid + '  log: ' + (existing.logFile || '—'));
    console.log('Stop first: swarm coordinator stop --swarm ' + swarmId);
    return;
  }

  const promptBody = renderCoordinatorPrompt(ws, { resume, goal: args.goal });
  const swarmDir = path.join(registryRoot, 'swarms', swarmId);
  fs.mkdirSync(swarmDir, { recursive: true });
  const promptFile = coordinatorPromptFile(registryRoot, swarmId);
  fs.writeFileSync(promptFile, promptBody, 'utf8');
  const logFile = coordinatorLogFile(registryRoot, swarmId);
  const runScript = path.join(skillRootDir(), 'bin', 'run-coordinator.sh');
  if (!fs.existsSync(runScript)) die('Missing ' + runScript);

  const modelArg = args.model && args.model !== 'true' ? args.model : null;
  const model = modelArg || coordinatorModel();
  const maxTurns = args['max-turns'] && args['max-turns'] !== 'true' ? String(args['max-turns']) : '500';
  const effort = args.effort && args.effort !== 'true' ? args.effort : 'high';

  const shellArgs = [
    runScript,
    '--repo', repoRoot,
    '--prompt-file', promptFile,
    '--log', logFile,
    '--max-turns', maxTurns,
    '--effort', effort,
  ];
  if (modelArg) shellArgs.push('--model', modelArg);
  if (sessionId) shellArgs.push('--session', sessionId);
  if (args['print-only'] === 'true') shellArgs.push('--print-only');

  if (args['print-only'] === 'true') {
    const { execFileSync } = require('child_process');
    const out = execFileSync('bash', shellArgs, {
      encoding: 'utf8',
      env: { ...process.env, SWARM_AGENT_NAME: 'Coordinator', SWARM_ID: swarmId === 'default' ? '' : swarmId },
    });
    console.log('Wrote coordinator prompt: ' + promptFile);
    process.stdout.write(out);
    return;
  }

  const { spawn } = require('child_process');
  // Prefer --daemon (default for start when not --foreground)
  const wantDaemon = args.daemon === 'true' || args.foreground !== 'true';

  if (wantDaemon) {
    // run-coordinator.sh owns the log file (redirect). Do not also attach fds to the same path.
    const child = spawn('bash', shellArgs, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, SWARM_AGENT_NAME: 'Coordinator', SWARM_ID: swarmId === 'default' ? '' : swarmId },
      cwd: repoRoot,
    });
    child.unref();
    const rec = {
      pid: child.pid,
      logFile,
      promptFile,
      sessionId: sessionId || null,
      mode: resume ? 'resume' : 'fresh',
      model,
      repo: repoRoot,
      swarmId,
      startedAt: Date.now(),
    };
    writeJsonPretty(coordinatorPidFile(registryRoot, swarmId), rec);
    // Archive a copy for later --resume session lookup
    const histDir = path.join(registryRoot, 'swarms', swarmId, 'coordinator-history');
    fs.mkdirSync(histDir, { recursive: true });
    writeJsonPretty(path.join(histDir, 'run-' + Date.now() + '.json'), rec);
    console.log('Coordinator daemon started: swarm=' + swarmId + ' pid ' + child.pid);
    console.log('  prompt: ' + promptFile);
    console.log('  log:    ' + logFile);
    console.log('Stop with: swarm coordinator stop --swarm ' + swarmId);
    console.log('Status:    swarm coordinator status --swarm ' + swarmId);
    return;
  }

  // Foreground: exec the coordinator (blocks)
  const { execFileSync } = require('child_process');
  try {
    execFileSync('bash', shellArgs, {
      stdio: 'inherit',
      env: { ...process.env, SWARM_AGENT_NAME: 'Coordinator', SWARM_ID: swarmId === 'default' ? '' : swarmId },
      cwd: repoRoot,
    });
  } catch (err) {
    process.exit(err.status || 1);
  }
}

function launchCommand(argv) {
  const args = parseArgs(argv);
  // Positional repo path optional — default cwd
  const repoArg = args._[0] || args.repo || args.cwd || process.cwd();
  const repo = path.resolve(repoArg);
  if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) {
    die('Repo path does not exist: ' + repo);
  }

  // Optional init if --goal / --fresh provided
  if (args.goal || args.fresh === 'true' || args.agents) {
    const initArgs = [repo];
    if (args.goal && args.goal !== 'true') initArgs.push('--goal', args.goal);
    if (args.agents && args.agents !== 'true') initArgs.push('--agents', args.agents);
    if (args.fresh === 'true') initArgs.push('--fresh');
    if (args.name && args.name !== 'true') initArgs.push('--name', args.name);
    initCommand(initArgs);
  }

  const registryRoot = path.join(repo, '.grok-swarm');
  if (!fs.existsSync(registryRoot)) {
    die('No .grok-swarm/ workspace. Run: swarm init ' + repo + ' --fresh --goal "..." --agents "..."  then create tasks, then swarm launch');
  }

  // Parent is expected to have created tasks already when launching without --goal.
  // Warn if no tasks exist.
  try {
    const registry = ensureRegistry(registryRoot);
    const swarmId = resolveSwarmId(registry, args);
    const ws = buildWorkspace(registryRoot, swarmId);
    const state = readState(ws);
    if (!(state.tasks || []).length) {
      console.log('WARNING: no tasks on the board yet. Create them before the coordinator can dispatch:');
      console.log('  SWARM_AGENT_NAME=Coordinator swarm task create --title "..." --owner "Builder 1" --files "..." --acceptance "..."');
    }
  } catch (err) {
    console.log('WARNING: could not read task state: ' + String(err && err.message || err));
  }

  if (args['no-dashboard'] !== 'true') {
    const dashArgs = ['--daemon', '--cwd', repo];
    if (args.open !== 'false') dashArgs.push('--open');
    if (args.port && args.port !== 'true') dashArgs.push('--port', String(args.port));
    dashboardCommand(dashArgs);
  }

  if (args['no-coordinator'] !== 'true') {
    const coordArgs = ['start', '--daemon', '--cwd', repo];
    if (args.resume === 'true') coordArgs.push('--resume');
    if (args.model && args.model !== 'true') coordArgs.push('--model', args.model);
    if (args.swarm && args.swarm !== 'true') coordArgs.push('--swarm', args.swarm);
    coordinatorCommand(coordArgs);
  }

  // Self-monitor agent: heal dead dispatches / dead dashboard / dead coordinators.
  // Safe defaults (no mega restart, no auto visual-pass). Opt out: --no-healer
  if (args['no-healer'] !== 'true') {
    try {
      const healApi = require('./heal.cjs');
      healApi.healCommand(
        {
          die,
          parseArgs,
          buildWorkspace,
          readState,
          readDispatches,
          reconcileDeadDispatches,
          skillRootDir,
        },
        ['start', '--daemon', '--repo', repo, '--interval', String(args['heal-interval'] || 30)],
      );
    } catch (err) {
      console.log('WARNING: could not start healer: ' + String(err && err.message || err));
    }
  }

  console.log('');
  console.log('Launch complete. Parent agent should EXIT now — do not babysit the monitor loop.');
  console.log('  Dashboard:  swarm dashboard status');
  console.log('  Coordinator: swarm coordinator status');
  console.log('  Healer:     swarm heal status');
  console.log('  Pause:      swarm pause && swarm coordinator stop');
  console.log('  Resume:     swarm resume && swarm coordinator start --resume --daemon');
}


// ---------------------------------------------------------------------------
// double-check gate (coordinator helper)
// ---------------------------------------------------------------------------
function doubleCheckReportPaths(repoRoot, taskId, worktreePath) {
  const rel = path.join('.grok-swarm', 'double-check', taskId + '.md');
  const paths = [];
  if (worktreePath) paths.push(path.join(worktreePath, rel));
  if (repoRoot) paths.push(path.join(repoRoot, rel));
  // also per-swarm folders if present (do not call ensureRegistry — it may process.exit)
  try {
    const swarmsDir = path.join(repoRoot, '.grok-swarm', 'swarms');
    if (fs.existsSync(swarmsDir)) {
      for (const id of fs.readdirSync(swarmsDir)) {
        paths.push(path.join(swarmsDir, id, 'double-check', taskId + '.md'));
      }
    }
  } catch { /* ignore */ }
  return paths;
}

function doubleCheckVerifyCommand(argv) {
  const args = parseArgs(argv);
  const taskId = args.task || args.id;
  if (!taskId || taskId === 'true') die('Usage: swarm double-check verify --task <taskId> [--repo PATH] [--worktree PATH] [--json]');
  const repo = path.resolve(args.repo || args.cwd || process.cwd());
  const wt = args.worktree && args.worktree !== 'true' ? path.resolve(args.worktree) : null;
  const candidates = doubleCheckReportPaths(repo, String(taskId), wt);
  let found = null;
  let body = '';
  for (const p of candidates) {
    if (typeof p === 'string' && fs.existsSync(p)) {
      found = p;
      body = fs.readFileSync(p, 'utf8');
      break;
    }
  }
  const complete = found && /Double-check result:\s*complete\b/i.test(body);
  const result = {
    ok: !!complete,
    found: !!found,
    path: found,
    candidates,
    complete: !!complete,
    preview: body ? body.slice(0, 400) : null,
  };
  if (args.json === 'true') console.log(JSON.stringify(result, null, 2));
  else if (complete) console.log('OK — double-check complete: ' + found);
  else if (found) {
    console.error('FAIL — report found but not complete: ' + found);
    console.error(body.split('\n').slice(0, 8).join('\n'));
  } else {
    console.error('FAIL — no double-check report for task ' + taskId);
    console.error('Looked in:\n  ' + candidates.join('\n  '));
  }
  process.exitCode = complete ? 0 : 1;
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------
const HELP = {
  init: 'swarm init <repoPath> [--goal "..."] [--agents "Label:role,..."] [--fresh]\n  Scaffold <repo>/.grok-swarm/ (board, inbox, events, dispatches). Idempotent.\n  --fresh archives any existing state to .grok-swarm/archive-<timestamp>/ first (use for every NEW swarm).\n  Plain init over an old workspace warns loudly and reuses stale goals/tasks.',
  mail: [
    'swarm mail send --to <label|@all> [--type ' + MAIL_TYPES.join('|') + '] --body "..."',
    'swarm mail check [--consume|--inject|--json]   read own inbox ($SWARM_AGENT_NAME)',
    'swarm mail peek [--json]                       non-consuming; exit 0 if mail waiting, 1 if empty',
  ].join('\n'),
  task: [
    'swarm task create --title "..." [--owner L] [--files a,b] [--acceptance "..."] [--depends id,..] [--force]',
    '  Refuses creation when --files overlap an active task unless sequenced via --depends or --force.',
    'swarm task update --id <id> [--status S] [--note "..."] [--owner --files --acceptance --depends --blocked] [--force]',
    'swarm task list [--owner L] [--status S] [--json]',
    'swarm task ready [--json]    open/assigned tasks whose deps are all done — safe to dispatch now',
    'Statuses: ' + [...TASK_STATUSES].join(' | '),
  ].join('\n'),
  goal: 'swarm goal create --title "..." [--status active]\nswarm goal update --id primary --status completed',
  agent: 'swarm agent register --label "Builder 3" [--role coordinator|builder|reviewer|scout|logger]\nswarm agent list [--json]\n  Roles: coordinator (orchestrate), scout (discover), builder (implement), reviewer (audit/visual), logger (compound learnings after merge).',
  capacity: [
    'swarm capacity show [--repo PATH] [--json]',
    '  Host-shared ceilings + live free slots across all active megas on this repo.',
    'swarm capacity set --max-coordinators N --max-builders N --max-reviewers N --max-scouts N --max-loggers N ...',
    '  Write .grok-swarm/host-capacity.json (defaults: 10/30/15/10/6 — not a hard 4-coord law).\n' +
    '  Also: min_free_ram_gb (default 2), auto_pause_low_memory (1=on) — dashboard/watch auto pause --all when MemAvailable < threshold.',
  ].join('\n'),
  learnings: [
    'swarm learnings list [--repo PATH] [--swarm ID] [--mega ID] [--json]',
    '  List learning docs written by Logger agents under .grok-swarm/learnings/ and docs/solutions/.',
    'swarm learnings path [--repo PATH]',
    '  Print preferred LEARNINGS_ROOT for this repo (docs/solutions if present).',
  ].join('\n'),
  dispatch: [
    'swarm dispatch record --task <id> [--agent L] [--worktree N] [--worktree-path P] [--log F] [--pid N] [--session S] [--base REF] [--status running] [--verify-worktree]',
    'swarm dispatch update --id <id> [--status running|done|failed|killed] [--session S] [--worktree-path P] [--pid N] [--exit-code N] [--note "..."]',
    'swarm dispatch list [--task T] [--agent A] [--status S] [--json] [--no-reconcile]',
    '  list auto-reconciles dead PIDs (running→done|failed) unless --no-reconcile.',
    'swarm dispatch reconcile [--dry-run] [--json]',
    '  Mark status=running dispatches whose PID is dead as done (log end) or failed.',
    '  Also runs automatically on dashboard/watch polls so "(exited?)" ghosts self-heal.',
  ].join('\n'),
  check: 'swarm check [--json] [--allow-serial-hub]\n  Validate the board: parallel file overlaps (without depends-on), missing deps, dependency cycles, and serial hot-hub chains (3+ tasks that share ≥3 hub files via depends_on — the one-builder-at-a-time anti-pattern). Exit 0 = clean. --allow-serial-hub skips the hub-chain rule for legacy boards.',
  board: 'swarm board            print live board (goal, tasks, agents, running dispatches)\nswarm board --sync     rewrite SWARM_BOARD.md marker sections from event state',
  state: 'swarm state            full JSON state {goals, tasks}',
  dashboard: 'swarm dashboard [--daemon] [--port 4599] [--open] | swarm dashboard stop | swarm dashboard status\n  Serve a live mission-control UI on localhost (kanban, live runs, log drawer).\n  Repo-scoped: one daemon per .grok-swarm/ (pidfile dashboard.pid at registry root).\n  API: GET /api/state?swarm=<id>, /api/host, /api/swarms, /api/log-tail?swarm=&dispatch=\n  Host RAM shown live; auto pause --all when MemAvailable < min_free_ram_gb (default 2G).\n  --daemon detaches the server (survives parent shell). --open launches Chrome. --port 0 = free port (foreground).',
  watch: [
    'swarm watch [<mega-id>] [--repo PATH] [--once] [--loop] [--json] [--compact] [--no-color] [--interval 2]',
    'swarm watch [--swarm <id>] [--all] [--once] [--json] [--compact] [--tail-log N] [--no-color]',
    '  Mega: pretty mission board (progress bar, grouped subswarms, live tasks, coordinators).',
    '    swarm watch mega-fe-refactor-20260714 --repo /path/to/repo',
    '    swarm mega watch --id mega-fe-refactor-20260714 --repo /path/to/repo',
    '    Default is one snapshot (agent-friendly). TTY live refresh: add --loop.',
    '  Single swarm: live task board (SSH-friendly). Non-TTY auto --once. Ctrl-C to exit.',
  ].join('\n'),
  swarms: 'swarm swarms list [--json] | swarm swarms use <id> | swarm swarms archive <id>\n  List/register default swarm; archive moves swarms/<id>/ to archive-<ts>/<id>/.',
  migrate: 'swarm migrate [--json]\n  Move legacy root-level .grok-swarm/ state into swarms/default/ + registry.json.',
  conflicts: 'swarm conflicts [--json]\n  Warn-only cross-swarm owned-file overlaps among active tasks.',
  pause: [
    'swarm pause [--all] [--reason "..."] [--no-kill] [--no-scavenge] [--json]',
    '  Halt builders: tree-kill (SIGTERM→SIGKILL) every running dispatch process + descendants.',
    '  Writes pause.json (task/worktree/sessionId/log/pid). Blocks new dispatch record until resume.',
    '  --all: EVERY swarm under .grok-swarm/swarms/ + stop all coordinators + mega daemons +',
    '         dashboard/heal + scavenge orphan grok/npm/tsc under repos-<basename> worktrees.',
    '  After kill: residual process check — exit 2 if anything still alive (do not trust CLI alone).',
    '  Prefer --all on mega / multi-swarm hosts (single-swarm pause only hits one sub-swarm).',
  ].join('\n'),
  resume: [
    'swarm resume [--all] [--json]',
    '  Lift pause: archive pause.json → pause-history/, print Mode C resume commands per interrupted builder',
    '  (`grok -p "Resume..." --cwd <WT_PATH> -r <sessionId> -m` from bin/model-pin.env).',
    '  --all: resume every paused swarm under the registry.',
  ].join('\n'),
  tick: [
    'swarm tick [--json]',
    '  Next legal coordinator actions from board state. Does not merge, kill, dispatch, or resume.',
    '  Types: hold, hard_pause, answer_mail, block, need_double_check, merge_candidate, dispatch, complete.',
    '  Model and role flags for dispatch come from dispatch-grok.sh (bin/model-pin.env).',
  ].join('\n'),
  coordinator: [
    'swarm coordinator start [--daemon] [--resume] [--session ID] [--model M] [--max-turns N] [--print-only] [--foreground]',
    '  Render templates/coordinator-prompt.md, write .grok-swarm/coordinator-prompt.md, and run the Grok CLI coordinator.',
    '  --daemon (default unless --foreground): detach with per-swarm pidfile',
    '  .grok-swarm/swarms/<id>/coordinator.pid + coordinator.log (parallel mega-safe).',
    '  status [--all] lists one or all coordinators; stop [--all] stops one or all.',
    '  --resume: continue from prior coordinator sessionId when known; do not re-init workspace.',
    '  --print-only: write prompt + print grok command without executing (tests / dry-run).',
    'swarm coordinator status [--json]   pid/log/mode; exit 0 if running',
    'swarm coordinator stop [--no-pause] SIGTERM coordinator daemon; hint if builders still running',
  ].join('\n'),
  launch: [
    'swarm launch [<repoPath>] [--goal "..."] [--agents "..."] [--fresh] [--resume] [--open] [--no-dashboard] [--no-coordinator] [--no-healer]',
    '  Orchestration entrypoint for autonomous mode:',
    '  optional init → dashboard --daemon --open → coordinator start --daemon → heal --daemon.',
    '  Parent agent should create tasks BEFORE launch (or right after init), then EXIT — do not babysit.',
    '  --no-healer skips the self-monitor agent; --heal-interval N sets poll seconds (default 30).',
  ].join('\n'),
  mega: [
    'swarm mega write-plan --plan plan.json [--repo PATH]',
    'swarm mega propose --repo PATH [--goal "..."] [--roots a,b] [--out plan.json] [--floor-tiny]',
    'swarm mega check|status|launch|mark|cleanup|doctor --id <mega-id>',
    'swarm mega watch [--id <mega-id>] [--repo PATH] [--json] [--loop]',
    '  Alias for: swarm watch <mega-id>  (mega status + coordinator status --all)',
    'swarm mega visual check|pass --id <mega> --sub <name>',
    'swarm mega merge --id <mega> [--to-main] [--gates "cmd"] [--skip-visual-gate]',
    'swarm mega tick --id <mega> [--force-visual-pass] [--auto-merge]',
    'swarm mega run --id <mega> [--daemon] [--loop] [--interval 20] [--auto-merge] [--to-main] [--auto-cleanup]',
    'swarm mega run --id <mega> --stop | --status',
    '  Hierarchical multi-swarm + meta daemon. Visual gate hard-blocks mark done when visual_review.',
    '  Integrate merge: sub branches → swarm/integrate/<id> → optional main. cleanup --full clears field.',
  ].join('\n'),
  cleanup: [
    'swarm cleanup --swarm <id> [--repo PATH] [--keep-branch] [--all-wt] [--json]',
    '  Tear down one swarm: SIGTERM running dispatches, remove worktrees, delete tied swarm/wt-* branches, archive workspace.',
    '  Branches are taken from dispatch records + live worktree HEADs (not only names containing the swarm id).',
    '  Also auto-runs after: swarm goal update --status completed (standalone; disable with --no-cleanup or GROK_SWARM_AUTO_CLEANUP=0).',
    '  Mandatory before the next mission so the field is clean.',
  ].join('\n'),
  'double-check': [
    'swarm double-check verify --task <taskId> [--repo PATH] [--worktree PATH] [--json]',
    '  Exit 0 if .grok-swarm/double-check/<taskId>.md exists and contains "Double-check result: complete".',
    '  Coordinator merge gate — prefer this over ad-hoc greps.',
  ].join('\n'),
  heal: [
    'swarm heal [--repo PATH] [--json] [--dry-run] [--auto-visual-pass] [--restart-mega]',
    '  One-shot self-monitor tick: reconcile dead dispatches, restart dead dashboard/coordinators,',
    '  promote visual PASS artifacts; with --auto-visual-pass force-pass only via visual-policy eligibility.',
    'swarm heal doctor [--repo PATH] [--json]     dry diagnosis (no restarts / no writes except none)',
    'swarm heal --daemon [--interval 30] [--repo PATH] [--auto-visual-pass] [--restart-mega]',
    '  Detached healer agent (pidfile .grok-swarm/heal/healer.pid). Survives parent shell reaping.',
    'swarm heal status|stop [--repo PATH] [--json]',
    '  Journal: .grok-swarm/heal/last.json + heal.log',
    '  Safe defaults: restarts dashboard + dead coordinators; does NOT restart mega unless --restart-mega;',
    '  does NOT auto visual-pass unless --auto-visual-pass (auth BLOCKED / age-aware; never product REVISE high).',
    '  FE mega heal daemons should pass --auto-visual-pass; interactive heal keeps default off.',
  ].join('\n'),
};

// Mega + cleanup (loaded after HELP keys that reference them; functions wired in main)
const megaApi = require('./mega.cjs').createMegaCommands({
  die,
  parseArgs,
  requireRegistryRoot,
  ensureRegistry,
  buildWorkspace,
  readState,
  writeRegistry,
  skillRootDir,
  initCommand,
  launchCommand,
  watchCommand,
  reconcileDeadDispatches,
});


function helpCommand(topic) {
  if (topic && HELP[topic]) {
    console.log(HELP[topic]);
    return;
  }
  console.log('grok-swarm CLI — coordination plumbing for Grok CLI multi-agent swarms');
  console.log('');
  console.log('Identity: every command reads $SWARM_AGENT_NAME (sender of mail, actor on events).');
  console.log('Workspace: .grok-swarm/ at repo root; per-swarm state under swarms/<id>/.');
  console.log('Selection: --swarm <id> or $SWARM_ID; auto when exactly one swarm; error when 2+ ambiguous.');
  console.log('');
  for (const key of Object.keys(HELP)) {
    console.log('## ' + key);
    console.log(HELP[key]);
    console.log('');
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function stripLeadingGlobals(argv) {
  const globals = {};
  let i = 0;
  while (i < argv.length) {
    if (argv[i] === '--swarm' && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      globals.swarm = argv[i + 1];
      i += 2;
      continue;
    }
    if (argv[i] === '--cwd' && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      globals.cwd = argv[i + 1];
      i += 2;
      continue;
    }
    break;
  }
  return { globals, rest: argv.slice(i) };
}

function mergeGlobalArgs(args, globals) {
  if (globals.cwd) args.cwd = globals.cwd;
  if (globals.swarm) args.swarm = globals.swarm;
  return args;
}

function versionCommand() {
  const skillRoot = path.resolve(__dirname, '..');
  let audit = 'unknown';
  try {
    const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
    const m = skill.match(/skill last audited \*\*([^*]+)\*\*/);
    if (m) audit = m[1].trim();
  } catch {}
  let caps = {};
  try {
    caps = require('./capacity.cjs').HOST_DEFAULT_CAPACITY || {};
  } catch {}
  // Also try template fallback
  if (!Object.keys(caps).length) {
    try {
      caps = JSON.parse(fs.readFileSync(path.join(skillRoot, 'templates/host-capacity.default.json'), 'utf8'));
    } catch {}
  }
  let grokVer = '';
  try {
    grokVer = require('child_process').execFileSync('grok', ['--version'], { encoding: 'utf8', timeout: 2000 }).trim();
  } catch (e) {
    grokVer = (e && e.message) ? String(e.message).split('\n')[0] : 'not found';
    if (grokVer.length > 80) grokVer = grokVer.slice(0, 80);
    grokVer = 'grok not available (' + grokVer + ')';
  }
  console.log('grok-swarm skill audited: ' + audit);
  console.log('host capacity defaults: ' + JSON.stringify(caps));
  console.log(grokVer);
}

function main() {
  const { globals, rest: rawArgv } = stripLeadingGlobals(process.argv.slice(2));
  const area = rawArgv[0] || '';
  const rest = rawArgv.slice(1);

  if (area === '--version' || area === 'version' || area === '-V') {
    versionCommand();
    return;
  }

  if (area === 'help' || area === '--help' || area === '-h') {
    helpCommand(rest[0]);
    return;
  }

  if (area === 'init') {
    initCommand(rest);
    return;
  }

  const args = mergeGlobalArgs(parseArgs(rest), globals);

  if (area === 'mail') {
    const ws = requireWorkspace(args);
    const action = rest[0] || '';
    const sub = rest.slice(1);
    if (action === 'send') mailSend(ws, parseArgs(sub));
    else if (action === 'check') mailCheck(ws, sub);
    else if (action === 'peek') mailCheck(ws, sub, { peek: true });
    else die('Usage: swarm mail send|check|peek ... (see: swarm help mail)');
    return;
  }

  if (area === 'task') {
    const ws = requireWorkspace(args);
    taskCommand(ws, rest[0] || '', rest.slice(1));
    return;
  }

  if (area === 'goal') {
    const ws = requireWorkspace(args);
    goalCommand(ws, rest[0] || '', rest.slice(1));
    return;
  }

  if (area === 'agent') {
    const ws = requireWorkspace(args);
    agentCommand(ws, rest[0] || '', rest.slice(1));
    return;
  }

  if (area === 'dispatch') {
    const ws = requireWorkspace(args);
    dispatchCommand(ws, rest[0] || '', rest.slice(1));
    return;
  }

  if (area === 'check') {
    const ws = requireWorkspace(args);
    checkCommand(ws, rest);
    return;
  }

  if (area === 'state') {
    const ws = requireWorkspace(args);
    console.log(JSON.stringify(readState(ws), null, 2));
    return;
  }

  if (area === 'board') {
    const ws = requireWorkspace(args);
    boardCommand(ws, rest);
    return;
  }

  if (area === 'dashboard') {
    dashboardCommand(rest);
    return;
  }

  if (area === 'watch') {
    watchCommand(rest);
    return;
  }

  if (area === 'swarms') {
    swarmsCommand(rest);
    return;
  }

  if (area === 'migrate') {
    migrateCommand(rest);
    return;
  }

  if (area === 'conflicts') {
    conflictsCommand(rest);
    return;
  }

  if (area === 'pause') {
    const pargs = parseArgs(rest);
    // --all or multi-swarm without explicit --swarm/SWARM_ID → registry-wide pause
    const registryRoot = requireRegistryRoot(args);
    const registry = ensureRegistry(registryRoot);
    const explicitSwarm = (args.swarm && args.swarm !== 'true') || process.env.SWARM_ID;
    const multi = (registry.swarms || []).length > 1;
    if (pargs.all === 'true' || (multi && !explicitSwarm && pargs.swarm !== 'true')) {
      if (pargs.all !== 'true' && multi && !explicitSwarm) {
        console.log('Note: multiple swarms registered — using pause --all (pass --swarm <id> for one).');
      }
      pauseAllCommand(registryRoot, rest.concat(pargs.all === 'true' ? [] : ['--all']));
      return;
    }
    const ws = requireWorkspace(args);
    pauseCommand(ws, rest);
    return;
  }

  if (area === 'resume') {
    const pargs = parseArgs(rest);
    if (pargs.all === 'true') {
      const registryRoot = requireRegistryRoot(args);
      const registry = ensureRegistry(registryRoot);
      const ids = (registry.swarms || []).map((s) => s.id);
      const swarmsDir = path.join(registryRoot, 'swarms');
      if (fs.existsSync(swarmsDir)) {
        for (const name of fs.readdirSync(swarmsDir)) {
          if (!ids.includes(name)) ids.push(name);
        }
      }
      for (const sid of ids) {
        const ws = buildWorkspace(registryRoot, sid);
        if (!fs.existsSync(ws.pauseFile)) continue;
        console.log('--- resume swarm=' + sid + ' ---');
        try {
          resumeCommand(ws, rest);
        } catch (err) {
          console.error('resume swarm=' + sid + ': ' + (err && err.message || err));
        }
      }
      return;
    }
    const ws = requireWorkspace(args);
    resumeCommand(ws, rest);
    return;
  }

  if (area === 'tick') {
    const ws = requireWorkspace(args);
    require('./tick.cjs').tickCommand({
      parseArgs,
      pause: readPause(ws),
      state: readState(ws),
      dispatches: readDispatches(ws),
      mail: readMailbox(path.join(ws.inbox, 'Coordinator')),
      repoRoot: ws.repoRoot,
      skillRoot: skillRootDir(),
    }, rest);
    return;
  }

  if (area === 'coordinator') {
    coordinatorCommand(rest);
    return;
  }

  if (area === 'launch') {
    launchCommand(rest);
    return;
  }

  if (area === 'mega') {
    megaApi.megaCommand(rawArgv.slice(1));
    return;
  }

  if (area === 'double-check' || area === 'doublecheck') {
    const sub = rest[0] || 'verify';
    if (sub === 'verify' || sub === 'check') doubleCheckVerifyCommand(rest.slice(1));
    else doubleCheckVerifyCommand(rest);
    return;
  }

  if (area === 'cleanup') {
    megaApi.cleanupSwarm(rest);
    return;
  }

  if (area === 'heal' || area === 'healer') {
    const healApi = require('./heal.cjs');
    healApi.healCommand(
      {
        die,
        parseArgs,
        buildWorkspace,
        readState,
        readDispatches,
        reconcileDeadDispatches,
        skillRootDir,
      },
      rest,
    );
    return;
  }

  if (area === 'capacity') {
    const capacityApi = require('./capacity.cjs');
    capacityApi.capacityCommand({ die, parseArgs }, rest);
    return;
  }

  if (area === 'learnings' || area === 'learning') {
    const learningsApi = require('./learnings.cjs');
    learningsApi.learningsCommand({ die, parseArgs }, rest);
    return;
  }

  console.error('Unknown command: ' + (area || '(none)'));
  console.error('');
  helpCommand();
  process.exit(1);
}

main();
