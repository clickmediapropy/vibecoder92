/**
 * Mega-swarm control plane (P1–P4) — plan, leases, capacity, launch, cleanup, doctor,
 * visual gate, integrate merge, meta daemon, partition propose, floor mode.
 * Loaded by swarm.cjs. Zero third-party deps.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const megaRuntime = require('./mega-runtime.cjs');
const capacityApi = require('./capacity.cjs');
const devServers = require('./dev-servers.cjs');
const {
  resolveVisualTier,
  shouldRequireReviewResult,
  VISUAL_TIERS,
} = require('./visual-policy.cjs');

/** Per-mega plan defaults — high ceilings; host-capacity.json + freeHostSlots gate real concurrency. */
const DEFAULT_CAPACITY = {
  ...capacityApi.MEGA_DEFAULT_CAPACITY,
};

const SUB_STATUSES = new Set([
  'planned', 'queued', 'running', 'done', 'blocked', 'cancelled', 'failed',
]);

function megaRoot(registryRoot) {
  return path.join(registryRoot, 'mega');
}

function megaDir(registryRoot, megaId) {
  return path.join(megaRoot(registryRoot), megaId);
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonPretty(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function slugOk(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,47}$/.test(id);
}

function normalizeFiles(files) {
  if (!Array.isArray(files)) return [];
  const out = [];
  const seen = new Set();
  for (const f of files) {
    const s = String(f || '').trim().replace(/\\/g, '/');
    if (!s || s.includes('..')) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * Strip trailing globs so lease paths compare as directory/file roots.
 * `src/components/ai/**` → `src/components/ai`
 */
function stripLeaseGlob(p) {
  let s = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (s.endsWith('/**')) s = s.slice(0, -3);
  else if (s.endsWith('/*')) s = s.slice(0, -2);
  else if (s.endsWith('/**/*')) s = s.slice(0, -5);
  return s.replace(/\/+$/, '');
}

/**
 * True if `parent` owns `child` as a path prefix with **segment boundaries**.
 * `src/components/ai` owns `src/components/ai/x` but NOT `src/components/ai-chat`.
 */
function isSegmentPathPrefix(parent, child) {
  if (!parent || !child) return false;
  if (parent === child) return true;
  return child.startsWith(parent + '/');
}

function pathsOverlap(a, b) {
  // Exact match or directory ownership (segment-safe — never treat "ai" as prefix of "ai-chat")
  if (a === b) return true;
  const na = stripLeaseGlob(a);
  const nb = stripLeaseGlob(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return isSegmentPathPrefix(na, nb) || isSegmentPathPrefix(nb, na);
}

function findLeaseConflicts(subswarms) {
  const problems = [];
  const byName = new Map(subswarms.map((s) => [s.name, s]));
  for (let i = 0; i < subswarms.length; i++) {
    for (let j = i + 1; j < subswarms.length; j++) {
      const a = subswarms[i];
      const b = subswarms[j];
      const aDeps = new Set(a.depends_on || []);
      const bDeps = new Set(b.depends_on || []);
      // Sequenced if either depends on the other (directly)
      if (aDeps.has(b.name) || bDeps.has(a.name)) continue;
      const aFiles = normalizeFiles(a.files);
      const bFiles = normalizeFiles(b.files);
      const shared = [];
      for (const fa of aFiles) {
        for (const fb of bFiles) {
          if (pathsOverlap(fa, fb)) shared.push(fa + ' ∩ ' + fb);
        }
      }
      if (shared.length) {
        problems.push({
          kind: 'lease-overlap',
          subswarms: [a.name, b.name],
          files: shared.slice(0, 20),
          message:
            a.name + ' and ' + b.name + ' have overlapping file leases without depends_on: ' +
            shared.slice(0, 5).join('; '),
        });
      }
    }
  }
  // missing deps + cycles
  for (const s of subswarms) {
    for (const d of s.depends_on || []) {
      if (!byName.has(d)) {
        problems.push({
          kind: 'missing-dep',
          subswarms: [s.name],
          message: s.name + ' depends_on unknown subswarm "' + d + '"',
        });
      }
    }
  }
  // cycle detect
  const visiting = new Set();
  const visited = new Set();
  function dfs(name, stack) {
    if (visiting.has(name)) {
      problems.push({
        kind: 'dep-cycle',
        subswarms: stack.concat(name),
        message: 'dependency cycle: ' + stack.concat(name).join(' → '),
      });
      return;
    }
    if (visited.has(name)) return;
    visiting.add(name);
    const node = byName.get(name);
    for (const d of (node && node.depends_on) || []) {
      if (byName.has(d)) dfs(d, stack.concat(name));
    }
    visiting.delete(name);
    visited.add(name);
  }
  for (const s of subswarms) dfs(s.name, []);
  return problems;
}

function validatePlan(plan) {
  const problems = [];
  if (!plan || typeof plan !== 'object') {
    return [{ kind: 'invalid', message: 'plan must be a JSON object' }];
  }
  if (!slugOk(plan.id)) {
    problems.push({ kind: 'invalid-id', message: 'plan.id must match ^[a-z0-9][a-z0-9-]{0,47}$' });
  }
  if (!plan.goal || typeof plan.goal !== 'string') {
    problems.push({ kind: 'invalid-goal', message: 'plan.goal required' });
  }
  if (!Array.isArray(plan.subswarms) || plan.subswarms.length === 0) {
    problems.push({ kind: 'no-subswarms', message: 'plan.subswarms must be a non-empty array' });
  } else {
    const names = new Set();
    for (const s of plan.subswarms) {
      if (!slugOk(s.name)) {
        problems.push({ kind: 'invalid-sub-name', message: 'invalid subswarm name: ' + s.name });
      }
      if (names.has(s.name)) {
        problems.push({ kind: 'dup-sub', message: 'duplicate subswarm name: ' + s.name });
      }
      names.add(s.name);
      const files = normalizeFiles(s.files);
      if (!files.length) {
        problems.push({ kind: 'no-files', subswarms: [s.name], message: s.name + ' has no files' });
      }
      s.files = files;
      s.depends_on = Array.isArray(s.depends_on) ? s.depends_on : [];
      s.builders = Math.max(1, Math.min(30, Number(s.builders) || 2));
      if (s.scouts === undefined) s.scouts = 1;
      else s.scouts = Math.max(0, Math.min(10, Number(s.scouts) || 0));
      if (s.loggers === undefined) s.loggers = 1;
      else s.loggers = Math.max(0, Math.min(4, Number(s.loggers) || 0));
      if (s.visual_tier != null && !VISUAL_TIERS.includes(String(s.visual_tier))) {
        problems.push({
          kind: 'invalid-visual-tier',
          subswarms: [s.name],
          message: s.name + ' invalid visual_tier',
        });
      }
      s.visual_tier = resolveVisualTier(s);
      if (s.visual_tier === 'gates_only') s.visual_review = false;
      else if (s.visual_review === undefined) s.visual_review = s.visual_tier !== 'gates_only';
      else s.visual_review = !!s.visual_review;
    }
    problems.push(...findLeaseConflicts(plan.subswarms));
  }
  const cap = { ...DEFAULT_CAPACITY, ...(plan.capacity || {}) };
  if (cap.max_coordinators < 1) problems.push({ kind: 'capacity', message: 'max_coordinators must be >= 1' });
  if (cap.max_builders < 1) problems.push({ kind: 'capacity', message: 'max_builders must be >= 1' });
  if (cap.max_scouts == null) cap.max_scouts = DEFAULT_CAPACITY.max_scouts;
  if (cap.max_loggers == null) cap.max_loggers = DEFAULT_CAPACITY.max_loggers;
  if (cap.max_reviewers == null) cap.max_reviewers = DEFAULT_CAPACITY.max_reviewers;
  plan.capacity = cap;
  if (!plan.integrate_branch) {
    plan.integrate_branch = 'swarm/integrate/' + (plan.id || 'mega');
  }
  if (!plan.default_branch) plan.default_branch = 'master';
  return problems;
}

function topoReady(plan, statusMap) {
  // statusMap: name -> planned|queued|running|done|...
  const ready = [];
  for (const s of plan.subswarms) {
    const st = statusMap[s.name] || 'planned';
    if (st !== 'planned' && st !== 'queued') continue;
    const deps = s.depends_on || [];
    const depsDone = deps.every((d) => statusMap[d] === 'done');
    if (depsDone) ready.push(s);
  }
  return ready;
}

function loadPlan(megaPath) {
  const planFile = path.join(megaPath, 'plan.json');
  if (!fs.existsSync(planFile)) return null;
  return readJsonSafe(planFile, null);
}

function loadState(megaPath) {
  return readJsonSafe(path.join(megaPath, 'state.json'), null);
}

function saveState(megaPath, state) {
  writeJsonPretty(path.join(megaPath, 'state.json'), state);
}

function shortSwarmId(megaId, subName) {
  const raw = String(megaId || 'mega').replace(/[^a-z0-9-]/g, '') + '-' + String(subName || 'sub').replace(/[^a-z0-9-]/g, '');
  return raw.slice(0, 48).replace(/-$/, '') || 'mega-sub';
}

function defaultState(plan) {
  const subs = {};
  for (const s of plan.subswarms) {
    subs[s.name] = {
      name: s.name,
      status: 'planned',
      swarmId: shortSwarmId(plan.id, s.name),
      branch: 'swarm/sub/' + plan.id + '/' + s.name,
      builders: s.builders,
      visual_review: !!s.visual_review,
      visual_tier: s.visual_tier || resolveVisualTier(s),
      floor: !!s.floor,
      files: s.files,
      depends_on: s.depends_on || [],
      worktrees: [],
      startedAt: null,
      finishedAt: null,
      note: '',
    };
  }
  return {
    megaId: plan.id,
    status: 'planned',
    goal: plan.goal,
    integrate_branch: plan.integrate_branch,
    default_branch: plan.default_branch,
    capacity: plan.capacity,
    subswarms: subs,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function listWorktreesForRepo(repoRoot) {
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
    });
    const trees = [];
    let cur = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (cur) trees.push(cur);
        cur = { path: line.slice('worktree '.length), branch: null };
      } else if (line.startsWith('branch ') && cur) {
        cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      }
    }
    if (cur) trees.push(cur);
    return trees;
  } catch {
    return [];
  }
}

function isProcessAlive(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid, signal) {
  try {
    process.kill(Number(pid), signal || 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} ctx
 * @param {function} ctx.die
 * @param {function} ctx.parseArgs
 * @param {function} ctx.requireRegistryRoot
 * @param {function} ctx.ensureRegistry
 * @param {function} ctx.buildWorkspace
 * @param {function} ctx.readState
 * @param {function} ctx.writeRegistry
 * @param {function} ctx.skillRootDir
 * @param {function} ctx.initCommand
 * @param {function} ctx.launchCommand
 * @param {function} ctx.swarmsCommand
 * @param {function} ctx.dispatchCommand
 * @param {function} ctx.readAgents
 */
function createMegaCommands(ctx) {
  const {
    die,
    parseArgs,
    requireRegistryRoot,
    ensureRegistry,
    buildWorkspace,
    readState,
    skillRootDir,
    initCommand,
    launchCommand,
  } = ctx;

  function resolveRepo(args) {
    const repoArg = args._[0] || args.repo || args.cwd || process.cwd();
    return path.resolve(repoArg);
  }

  function resolveMegaId(args, registryRoot) {
    const id =
      (args.id && args.id !== 'true' ? args.id : null) ||
      // positional: `mega status mega-foo` → _[1]; `mega watch mega-foo` after slice → _[0]
      (args._[0] && !String(args._[0]).startsWith('--') &&
        !['write-plan', 'plan', 'check', 'status', 'watch', 'launch', 'cleanup', 'doctor', 'mark', 'visual', 'merge', 'propose', 'tick', 'run'].includes(args._[0])
        ? args._[0] : null) ||
      (args._[1] && !String(args._[1]).startsWith('--') ? args._[1] : null) ||
      process.env.MEGA_ID ||
      null;
    if (id) return id;
    const root = megaRoot(registryRoot);
    if (!fs.existsSync(root)) return null;
    const active = fs.readdirSync(root).filter((n) => {
      if (n === 'archive' || n.startsWith('archive')) return false;
      return fs.existsSync(path.join(root, n, 'plan.json'));
    });
    if (active.length === 1) return active[0];
    return null;
  }

  function megaWritePlan(argv) {
    const args = parseArgs(argv);
    const repo = resolveRepo(args);
    const planPath = args.plan || args.file || args._[0];
    if (!planPath || planPath === true) die('Usage: swarm mega write-plan --plan <plan.json> [--repo PATH]');
    const abs = path.resolve(planPath);
    if (!fs.existsSync(abs)) die('Plan file not found: ' + abs);
    const plan = readJsonSafe(abs, null);
    const problems = validatePlan(plan);
    if (problems.length) {
      if (args.json === 'true') {
        console.log(JSON.stringify({ ok: false, problems }, null, 2));
      } else {
        console.error('Plan invalid:');
        for (const p of problems) console.error('  - ' + p.message);
      }
      process.exit(1);
    }
    if (!plan.base_ref) {
      try {
        plan.base_ref = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      } catch {
        plan.base_ref = 'HEAD';
      }
    }
    plan.repo = repo;
    const registryRoot = path.join(repo, '.grok-swarm');
    fs.mkdirSync(registryRoot, { recursive: true });
    // Ensure host capacity file exists (high defaults; shared across parallel megas)
    if (!fs.existsSync(capacityApi.hostCapacityPath(registryRoot))) {
      capacityApi.saveHostCapacity(registryRoot, capacityApi.HOST_DEFAULT_CAPACITY);
    }
    // Cross-mega lease check at write time
    const crossWrite = capacityApi.findCrossMegaLeaseConflicts(registryRoot, plan, {
      excludeMegaId: plan.id,
    });
    if (crossWrite.length && args.force !== 'true') {
      console.error('Plan leases overlap an active mega:');
      for (const c of crossWrite.slice(0, 15)) console.error('  - ' + c.message);
      console.error('Adjust files leases or pass --force (dangerous).');
      process.exit(1);
    }
    // Ensure seed file exists for dispatch-grok
    const seedDest = path.join(registryRoot, 'worktree-seed.json');
    if (!fs.existsSync(seedDest)) {
      const skillSeed = path.join(skillRootDir(), 'templates', 'worktree-seed.default.json');
      if (plan.worktree_seed) {
        writeJsonPretty(seedDest, plan.worktree_seed);
      } else if (fs.existsSync(skillSeed)) {
        fs.copyFileSync(skillSeed, seedDest);
      }
    } else if (plan.worktree_seed) {
      writeJsonPretty(path.join(megaDir(registryRoot, plan.id), 'worktree-seed.json'), plan.worktree_seed);
    }

    const dir = megaDir(registryRoot, plan.id);
    fs.mkdirSync(dir, { recursive: true });
    writeJsonPretty(path.join(dir, 'plan.json'), plan);
    const state = defaultState(plan);
    saveState(dir, state);
    // leases snapshot
    const leases = {};
    for (const s of plan.subswarms) {
      leases[s.name] = { files: s.files, status: 'planned', depends_on: s.depends_on || [] };
    }
    writeJsonPretty(path.join(dir, 'leases.json'), leases);

    if (args.json === 'true') {
      console.log(JSON.stringify({ ok: true, megaId: plan.id, path: dir, subswarms: plan.subswarms.length }, null, 2));
    } else {
      console.log('Mega plan written: ' + plan.id);
      console.log('  dir: ' + dir);
      console.log('  subswarms: ' + plan.subswarms.map((s) => s.name).join(', '));
      console.log('  integrate: ' + plan.integrate_branch);
      console.log('  capacity (plan): builders=' + plan.capacity.max_builders +
        ' coordinators=' + plan.capacity.max_coordinators +
        ' reviewers=' + plan.capacity.max_reviewers +
        ' scouts=' + (plan.capacity.max_scouts || 0));
      const hs = capacityApi.freeHostSlots(registryRoot, plan.capacity);
      console.log('  host free: coord=' + hs.free.coordinators +
        ' builders=' + hs.free.builders +
        (hs.usage.megas.length
          ? ' | active: ' + hs.usage.megas.map((m) => m.megaId).join(', ')
          : ''));
      console.log('Next: swarm mega check --id ' + plan.id + ' && swarm mega launch --id ' + plan.id);
      console.log('Parallel megas: disjoint --files leases + shared host capacity (swarm capacity show)');
    }
  }

  function megaCheck(argv) {
    const args = parseArgs(argv);
    const repo = resolveRepo(args);
    const registryRoot = path.join(repo, '.grok-swarm');
    const megaId = resolveMegaId(args, registryRoot);
    if (!megaId) die('Usage: swarm mega check --id <mega-id> [--repo PATH] [--json]');
    const dir = megaDir(registryRoot, megaId);
    const plan = loadPlan(dir);
    if (!plan) die('No plan at ' + path.join(dir, 'plan.json') + ' — run mega write-plan first');
    const problems = validatePlan(plan);
    // Also check seed required files on MAIN
    const seed = plan.worktree_seed || readJsonSafe(path.join(registryRoot, 'worktree-seed.json'), {});
    for (const rel of seed.required || []) {
      if (!fs.existsSync(path.join(repo, rel))) {
        problems.push({ kind: 'seed-missing', message: 'required seed file missing on MAIN: ' + rel });
      }
    }
    // Cross-mega lease clashes with other active megas
    const cross = capacityApi.findCrossMegaLeaseConflicts(registryRoot, plan, { excludeMegaId: megaId });
    for (const c of cross) problems.push(c);

    const hostSlots = capacityApi.freeHostSlots(registryRoot, plan.capacity);
    const ok = problems.length === 0;
    if (args.json === 'true') {
      console.log(JSON.stringify({
        ok,
        megaId,
        problems,
        capacity: plan.capacity,
        host_slots: hostSlots,
        peer_megas: hostSlots.usage.megas,
      }, null, 2));
    } else if (ok) {
      console.log('OK — mega plan "' + megaId + '" valid (' + plan.subswarms.length + ' subswarms, plan max_coordinators=' +
        plan.capacity.max_coordinators + ')');
      console.log('  effective free (min host×plan): coord=' + hostSlots.free.coordinators +
        ' builders=' + hostSlots.free.builders +
        ' reviewers=' + hostSlots.free.reviewers +
        ' scouts=' + hostSlots.free.scouts +
        '  | host ceiling coord=' + hostSlots.host.max_coordinators +
        (hostSlots.usage.megas.length
          ? '  | active: ' + hostSlots.usage.megas.map((m) => m.megaId).join(', ')
          : '  | no other active megas'));
    } else {
      console.error('Mega check FAILED:');
      for (const p of problems) console.error('  - ' + p.message);
    }
    process.exitCode = ok ? 0 : 1;
  }

  function megaStatus(argv) {
    const args = parseArgs(argv);
    const repo = resolveRepo(args);
    const registryRoot = path.join(repo, '.grok-swarm');
    const megaId = resolveMegaId(args, registryRoot);
    if (!megaId) {
      // list all
      const root = megaRoot(registryRoot);
      if (!fs.existsSync(root)) {
        console.log('No mega missions.');
        return;
      }
      const ids = fs.readdirSync(root).filter((n) => fs.existsSync(path.join(root, n, 'plan.json')));
      if (args.json === 'true') {
        console.log(JSON.stringify({ megas: ids }, null, 2));
        return;
      }
      for (const id of ids) {
        const st = loadState(path.join(root, id));
        console.log(id + '  ' + (st && st.status || '?') + '  ' + (st && st.goal || ''));
      }
      return;
    }
    const dir = megaDir(registryRoot, megaId);
    const state = loadState(dir);
    const plan = loadPlan(dir);
    if (!state) die('No mega state for ' + megaId);
    // refresh running slots from registry swarms if present
    let runningCoords = 0;
    for (const name of Object.keys(state.subswarms || {})) {
      if (state.subswarms[name].status === 'running') runningCoords++;
    }
    // E1 — enrich queued_reason (capacity vs depends_on) for status/watch consumers
    const statusMap = {};
    for (const name of Object.keys(state.subswarms || {})) {
      statusMap[name] = state.subswarms[name].status;
    }
    const queued = [];
    for (const name of Object.keys(state.subswarms || {})) {
      const s = state.subswarms[name];
      const planSub = (plan && plan.subswarms || []).find((x) => x.name === name) || {};
      const reason = megaRuntime.queuedReason
        ? megaRuntime.queuedReason(
          { name, status: s.status, depends_on: s.depends_on || planSub.depends_on },
          statusMap,
        )
        : null;
      if (reason) {
        s.queued_reason = reason;
        queued.push({ name, reason, status: s.status });
      } else if (s.queued_reason) {
        delete s.queued_reason;
      }
    }
    if (args.json === 'true') {
      console.log(JSON.stringify({
        megaId,
        state,
        plan: plan && { capacity: plan.capacity, integrate_branch: plan.integrate_branch },
        queued,
      }, null, 2));
      return;
    }
    console.log('Mega: ' + megaId + '  status=' + state.status);
    console.log('Goal: ' + state.goal);
    console.log('Integrate: ' + state.integrate_branch + ' → ' + state.default_branch);
    console.log('Capacity: builders≤' + (state.capacity && state.capacity.max_builders) +
      ' coordinators≤' + (state.capacity && state.capacity.max_coordinators) +
      '  running_coordinators≈' + runningCoords);
    console.log('Subswarms:');
    for (const name of Object.keys(state.subswarms || {})) {
      const s = state.subswarms[name];
      console.log('  ' + name + '  [' + s.status + ']' +
        (s.queued_reason ? '  queued_reason=' + s.queued_reason : '') +
        '  swarmId=' + s.swarmId +
        (s.depends_on && s.depends_on.length ? '  deps=' + s.depends_on.join(',') : '') +
        (s.visual_review ? '  visual' : ''));
    }
  }

  function megaLaunch(argv) {
    const args = parseArgs(argv);
    const repo = resolveRepo(args);
    const registryRoot = path.join(repo, '.grok-swarm');
    const megaId = resolveMegaId(args, registryRoot);
    if (!megaId) die('Usage: swarm mega launch --id <mega-id> [--repo PATH] [--force] [--dry-run] [--no-coordinator]');
    const dir = megaDir(registryRoot, megaId);
    const plan = loadPlan(dir);
    if (!plan) die('Missing plan — swarm mega write-plan --plan ... first');
    const problems = validatePlan(plan);
    if (problems.length && args.force !== 'true') {
      console.error('mega check failed; fix plan or pass --force');
      for (const p of problems) console.error('  - ' + p.message);
      process.exitCode = 1;
      return;
    }

    // doctor soft — peer megas / leftover worktrees are info; parallel megas are OK
    if (args.force !== 'true') {
      const dirty = doctorIssues(repo, { soft: true });
      if (dirty.length) {
        console.log('WARNING: soft doctor notes (' + dirty.length + ') — parallel megas are OK; leftover worktrees may need cleanup');
        for (const d of dirty.slice(0, 5)) console.log('  - ' + d);
        if (args['require-clean'] === 'true') {
          process.exitCode = 1;
          return;
        }
      }
    }

    let state = loadState(dir) || defaultState(plan);
    state.status = 'running';
    state.updatedAt = Date.now();

    const statusMap = {};
    for (const name of Object.keys(state.subswarms)) {
      statusMap[name] = state.subswarms[name].status;
    }

    // Cross-mega leases (hard block unless --force)
    const cross = capacityApi.findCrossMegaLeaseConflicts(registryRoot, plan, { excludeMegaId: megaId });
    if (cross.length && args.force !== 'true') {
      console.error('Refusing mega launch: file leases overlap an active mega (would hurt peer mission).');
      for (const c of cross.slice(0, 15)) console.error('  - ' + c.message);
      console.error('Fix leases, wait for peer mega, or pass --force (dangerous).');
      process.exitCode = 1;
      return;
    }
    if (cross.length && args.force === 'true') {
      console.log('WARNING: --force ignoring ' + cross.length + ' cross-mega lease clash(es)');
    }

    // Host-shared free coordinator slots (not a hard "4" — host-capacity.json defaults to 10)
    const hostSlots = capacityApi.freeHostSlots(registryRoot, plan.capacity);
    // Running count for THIS mega only for internal bookkeeping; free coords gate NEW starts
    let thisRunning = Object.values(state.subswarms).filter((s) => s.status === 'running').length;
    // Free slots already exclude other megas' live coords. Also subtract this mega's
    // already-running (they're in measureHostUsage) — so free.coordinators is total free.
    let freeCoord = hostSlots.free.coordinators;
    const ready = topoReady(plan, statusMap);
    const toStart = [];
    for (const s of ready) {
      if (freeCoord <= 0) {
        state.subswarms[s.name].status = 'queued';
        state.subswarms[s.name].queued_reason = 'capacity';
        statusMap[s.name] = 'queued';
        continue;
      }
      toStart.push(s);
      freeCoord--;
      thisRunning++;
    }
    // E1 — label planned/queued packs waiting on deps
    for (const s of plan.subswarms) {
      const st = state.subswarms[s.name];
      if (!st) continue;
      const reason = megaRuntime.queuedReason
        ? megaRuntime.queuedReason(
          { name: s.name, status: st.status, depends_on: s.depends_on || st.depends_on },
          statusMap,
        )
        : null;
      if (reason) st.queued_reason = reason;
      else if (st.queued_reason) delete st.queued_reason;
    }

    if (args['dry-run'] === 'true' || args.json === 'true' && args.launch !== 'true') {
      // dry-run listing
      const payload = {
        megaId,
        wouldStart: toStart.map((s) => s.name),
        queued: plan.subswarms.filter((s) => (statusMap[s.name] || 'planned') === 'queued').map((s) => s.name),
        capacity: plan.capacity,
        host_slots: hostSlots,
        peer_megas: hostSlots.usage.megas,
        cross_mega_leases: cross,
      };
      if (args['dry-run'] === 'true') {
        console.log(JSON.stringify(payload, null, 2));
        // still update queued markers? no
        return;
      }
    }

    const started = [];
    for (const s of toStart) {
      // Swarm ids must match SWARM_ID_RE (≤48 chars). Prefer precomputed short id.
      let swarmId = state.subswarms[s.name].swarmId;
      if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(swarmId)) {
        swarmId = (plan.id.replace(/[^a-z0-9-]/g, '').slice(0, 20) + '-' + s.name).slice(0, 48);
        state.subswarms[s.name].swarmId = swarmId;
      }
      const title = s.title || s.name + ': ' + plan.goal;
      const nScouts = s.scouts != null ? s.scouts : 1;
      const nLoggers = s.loggers != null ? s.loggers : 1;
      // D5 — skip Visual Reviewer agent when tier is gates_only (resolveVisualTier wins over stale visual_review)
      const launchTier = resolveVisualTier(s);
      const needsVisualAgent = shouldRequireReviewResult(launchTier);
      const agents =
        s.agents ||
        'Coordinator:coordinator,' +
          (nScouts > 0
            ? Array.from({ length: nScouts }, (_, i) => 'Scout ' + (i + 1) + ':scout').join(',') + ','
            : '') +
          Array.from({ length: s.builders }, (_, i) => 'Builder ' + (i + 1) + ':builder').join(',') +
          ',Reviewer:reviewer' +
          (needsVisualAgent ? ',Visual Reviewer:reviewer' : '') +
          (nLoggers > 0
            ? ',' + Array.from({ length: nLoggers }, (_, i) => 'Logger ' + (i + 1) + ':logger').join(',')
            : '');

      if (args['dry-run'] === 'true') continue;

      // init sub-swarm workspace
      const initArgs = [
        repo,
        '--fresh',
        '--name', swarmId,
        '--goal', title,
        '--agents', agents,
      ];
      try {
        initCommand(initArgs);
      } catch (err) {
        console.error('init failed for ' + swarmId + ': ' + (err && err.message || err));
        state.subswarms[s.name].status = 'failed';
        state.subswarms[s.name].note = String(err && err.message || err);
        continue;
      }

      // create one umbrella task with file lease (parent may refine into more tasks later)
      // Use nested invocation via child to avoid circular require of taskCommand
      const swarmBin = path.join(skillRootDir(), 'bin', 'swarm.cjs');
      const filesArg = (s.files || []).join(',');
      try {
        execFileSync(
          process.execPath,
          [
            swarmBin,
            '--swarm', swarmId,
            'task', 'create',
            '--title', title,
            '--owner', 'Builder 1',
            '--files', filesArg,
            '--acceptance', s.acceptance || 'gates green; /double-check complete (.grok-swarm/double-check/<taskId>.md); visual PASS if UI',
          ],
          {
            cwd: repo,
            env: { ...process.env, SWARM_AGENT_NAME: 'Coordinator', SWARM_ID: swarmId },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
      } catch (err) {
        console.error('task create failed for ' + swarmId + ': ' + (err.stderr || err.message || err));
      }

      // Write mega context for coordinator
      const megaCtx = {
        megaId: plan.id,
        subswarm: s.name,
        integrate_branch: plan.integrate_branch,
        sub_branch: state.subswarms[s.name].branch,
        default_branch: plan.default_branch,
        visual_review: needsVisualAgent,
        visual_tier: launchTier,
        visual_skipped: !needsVisualAgent,
        merge_target: state.subswarms[s.name].branch,
        never_merge_to_main: true,
      };
      state.subswarms[s.name].visual_tier = launchTier;
      if (!needsVisualAgent) {
        state.subswarms[s.name].visualSkipped = true;
        state.subswarms[s.name].visual_review = false;
      }
      // clear queue reason when starting
      delete state.subswarms[s.name].queued_reason;
      writeJsonPretty(
        path.join(registryRoot, 'swarms', swarmId, 'mega-context.json'),
        megaCtx,
      );

      const planSub = plan.subswarms.find((x) => x.name === s.name) || s;
      const useFloor = !!(planSub.floor || state.subswarms[s.name].floor);
      state.subswarms[s.name].floor = useFloor;

      // Floor mode: no Grok coordinator LLM — meta daemon / tick dispatches builders
      if (!useFloor && args['no-coordinator'] !== 'true') {
        try {
          launchCommand([
            repo,
            '--swarm', swarmId,
            ...(args.open === 'false' ? [] : []),
            ...(args['no-dashboard'] === 'true' ? ['--no-dashboard'] : []),
          ]);
        } catch (err) {
          console.error('launch failed for ' + swarmId + ': ' + (err && err.message || err));
        }
      } else if (useFloor && args.quiet !== 'true') {
        console.log('  floor mode (no Grok coordinator): ' + swarmId);
      }

      state.subswarms[s.name].status = 'running';
      state.subswarms[s.name].startedAt = Date.now();
      statusMap[s.name] = 'running';
      started.push(swarmId);
    }

    // Mark remaining ready-but-capped as queued
    for (const s of plan.subswarms) {
      if (statusMap[s.name] === 'planned' || statusMap[s.name] === 'queued') {
        const deps = s.depends_on || [];
        const depsOk = deps.every((d) => statusMap[d] === 'done');
        if (!depsOk) continue;
        // still not started this wave → stay/queue
        if (!started.includes(state.subswarms[s.name].swarmId) &&
            state.subswarms[s.name].status !== 'running' &&
            state.subswarms[s.name].status !== 'done') {
          state.subswarms[s.name].status = 'queued';
        }
      }
    }

    // Re-entrant launch: already-running/done preserved; only starts planned/queued with free capacity
    if (!started.length && Object.values(state.subswarms).every((s) => s.status === 'done' || s.status === 'cancelled')) {
      state.status = 'completed';
    }

    saveState(dir, state);
    writeJsonPretty(path.join(dir, 'leases.json'), Object.fromEntries(
      Object.entries(state.subswarms).map(([name, s]) => [name, {
        files: s.files,
        status: s.status,
        depends_on: s.depends_on,
        swarmId: s.swarmId,
      }]),
    ));

    if (args.quiet === 'true') {
      return { ok: true, megaId, started, state, host_slots: hostSlots };
    }
    if (args.json === 'true') {
      console.log(JSON.stringify({ ok: true, megaId, started, state, host_slots: hostSlots }, null, 2));
    } else {
      console.log('Mega launch: ' + megaId);
      console.log('  host free (after): coord≈' + capacityApi.freeHostSlots(registryRoot, plan.capacity).free.coordinators +
        '  peers: ' + (hostSlots.usage.megas.filter((m) => m.megaId !== megaId).map((m) => m.megaId).join(', ') || 'none'));
      console.log('  started: ' + (started.join(', ') || '(none — deps/capacity)'));
      console.log('  Parent should EXIT. Monitor: swarm mega status --id ' + megaId);
      console.log('  When done: swarm mega cleanup --id ' + megaId + ' --full');
      console.log('  Meta loop: swarm mega run --id ' + megaId + ' --daemon');
    }
    return { ok: true, megaId, started, state };
  }

  function collectRunningPids(registryRoot, swarmId) {
    const pids = [];
    const ws = buildWorkspace(registryRoot, swarmId);
    const dispDir = ws.dispatches || ws.dispatchesDir;
    if (!dispDir || !fs.existsSync(dispDir)) return pids;
    for (const f of fs.readdirSync(dispDir).filter((x) => x.endsWith('.json'))) {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(dispDir, f), 'utf8'));
        if (rec.status === 'running' && rec.pid) pids.push({ pid: rec.pid, kind: 'dispatch', id: rec.id });
      } catch { /* ignore */ }
    }
    return pids;
  }

  /**
   * Optional Grok CLI worktree GC after mega cleanup.
   * Default on; set GROK_SWARM_WORKTREE_GC=0 to skip. Soft-fails (warn only).
   * 1.0.3: without --max-age, `grok worktree gc` expires nothing.
   */
  function maybeGrokWorktreeGc(report) {
    if (process.env.GROK_SWARM_WORKTREE_GC === '0') {
      if (report) report.grokWorktreeGc = 'skipped (GROK_SWARM_WORKTREE_GC=0)';
      return;
    }
    const maxAge = process.env.GROK_SWARM_WORKTREE_GC_MAX_AGE || '7d';
    try {
      execFileSync('grok', ['worktree', 'gc', '--max-age', maxAge], {
        encoding: 'utf8',
        timeout: 60000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (report) report.grokWorktreeGc = 'ran: grok worktree gc --max-age ' + maxAge;
      else console.log('ran: grok worktree gc --max-age ' + maxAge);
    } catch (e) {
      const msg = String((e && e.stderr) || (e && e.message) || e);
      if (report) report.grokWorktreeGc = 'warn: grok worktree gc failed: ' + msg;
      else console.log('warn: grok worktree gc failed: ' + msg);
    }
  }

  function cleanupSwarm(argv) {
    const args = parseArgs(argv);
    const repo = resolveRepo(args);
    const registryRoot = path.join(repo, '.grok-swarm');
    ensureRegistry(registryRoot);
    const swarmId =
      (args.swarm && args.swarm !== 'true' ? args.swarm : null) ||
      (args.id && args.id !== 'true' ? args.id : null) ||
      process.env.SWARM_ID;
    if (!swarmId) die('Usage: swarm cleanup --swarm <id> [--repo PATH] [--keep-branch] [--json]');

    const report = { swarmId, killed: [], worktreesRemoved: [], branchesDeleted: [], errors: [] };
    const pids = collectRunningPids(registryRoot, swarmId);
    // coordinator pid if matching swarm
    const coordPidFile = path.join(registryRoot, 'coordinator.pid');
    const coord = readJsonSafe(coordPidFile, null);
    if (coord && coord.swarmId === swarmId && coord.pid && isProcessAlive(coord.pid)) {
      killPid(coord.pid, 'SIGTERM');
      report.killed.push({ pid: coord.pid, kind: 'coordinator' });
    }
    for (const p of pids) {
      if (isProcessAlive(p.pid)) {
        killPid(p.pid, 'SIGTERM');
        report.killed.push(p);
      }
    }

    // worktrees: swarm/wt-* or paths recorded in dispatches
    const trees = listWorktreesForRepo(repo);
    const ws = buildWorkspace(registryRoot, swarmId);
    const wtPaths = new Set();
    /** Branch names known to belong to this swarm (dispatch records + removed trees). */
    const tiedBranches = new Set();
    const addWt = (p) => {
      if (typeof p === 'string' && p.trim()) wtPaths.add(p.trim());
    };
    const addBranch = (b) => {
      if (typeof b === 'string' && b.trim()) {
        const name = b.trim().replace(/^refs\/heads\//, '');
        if (name && name !== 'HEAD') tiedBranches.add(name);
      }
    };
    // buildWorkspace exposes `dispatches` (not dispatchesDir) — support both.
    const dispDir = ws.dispatches || ws.dispatchesDir;
    if (dispDir && fs.existsSync(dispDir)) {
      for (const f of fs.readdirSync(dispDir).filter((x) => x.endsWith('.json'))) {
        try {
          const rec = JSON.parse(fs.readFileSync(path.join(dispDir, f), 'utf8'));
          addWt(rec.worktreePath);
          if (rec.worktree && typeof rec.worktree === 'string' && rec.worktree !== 'main') {
            // default layout
            const base = process.env.GROK_WORKTREES_ROOT || path.join(process.env.HOME || '', '.grok', 'worktrees');
            addWt(path.join(base, 'repos-' + path.basename(repo), rec.worktree));
            // dispatch-grok names branches swarm/<worktree>
            addBranch('swarm/' + rec.worktree);
            addBranch(rec.worktree);
          }
          if (rec.branch) addBranch(rec.branch);
        } catch { /* ignore */ }
      }
    }
    for (const t of trees) {
      if (!t || typeof t.path !== 'string') continue;
      if (t.path.includes(swarmId) || (t.branch && String(t.branch).includes(swarmId))) {
        addWt(t.path);
      }
      // Also pick worktrees whose path basename matches a dispatch worktree name
      const baseName = path.basename(t.path);
      if (tiedBranches.has('swarm/' + baseName) || tiedBranches.has(baseName)) {
        addWt(t.path);
        if (t.branch) addBranch(t.branch);
      }
    }

    for (const wt of wtPaths) {
      if (typeof wt !== 'string' || !wt || !fs.existsSync(wt)) continue;
      // never remove MAIN
      try {
        const top = execFileSync('git', ['-C', wt, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
        const main = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
        if (path.resolve(top) === path.resolve(main)) {
          report.errors.push('refused to remove MAIN: ' + wt);
          continue;
        }
      } catch (err) {
        report.errors.push(String(err.message || err));
        continue;
      }
      // Capture branch before remove so we can delete it even without --all-wt
      try {
        const br = execFileSync('git', ['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD'], {
          encoding: 'utf8',
        }).trim();
        addBranch(br);
      } catch { /* detached HEAD ok */ }
      try {
        execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', wt], { encoding: 'utf8' });
        report.worktreesRemoved.push(wt);
      } catch (err) {
        // try rm -rf worktree then prune
        try {
          fs.rmSync(wt, { recursive: true, force: true });
          execFileSync('git', ['-C', repo, 'worktree', 'prune'], { encoding: 'utf8' });
          report.worktreesRemoved.push(wt + ' (rm+prune)');
        } catch (err2) {
          report.errors.push('worktree remove failed: ' + wt + ' — ' + (err2.message || err2));
        }
      }
    }

    if (args['keep-branch'] !== 'true') {
      // Delete branches tied to this swarm: by swarm id, dispatch worktree names,
      // or --all-wt (every swarm/wt-* — use when a single mission owns the host).
      try {
        const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'swarm/*'], { encoding: 'utf8' })
          .split('\n')
          .map((l) => l.replace(/^\*?\s+/, '').trim())
          .filter(Boolean);
        for (const b of branches) {
          const tied =
            b.includes(swarmId) ||
            tiedBranches.has(b) ||
            (args['all-wt'] === 'true' && b.startsWith('swarm/wt-'));
          if (!tied) continue;
          try {
            execFileSync('git', ['-C', repo, 'branch', '-D', b], { encoding: 'utf8' });
            report.branchesDeleted.push(b);
          } catch (err) {
            report.errors.push('branch -D ' + b + ': ' + (err.message || err));
          }
        }
      } catch { /* ignore */ }
    }

    // Kill vite/dev-server PIDs whose cmdline includes cleaned worktree paths.
    // Never pass MAIN as a kill root — only worktree paths.
    try {
      let mainTop = repo;
      try {
        mainTop = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], {
          encoding: 'utf8',
        }).trim();
      } catch { /* keep repo */ }
      const killRoots = [...wtPaths].filter((p) => {
        if (typeof p !== 'string' || !p.trim()) return false;
        try {
          return path.resolve(p) !== path.resolve(mainTop);
        } catch {
          return true;
        }
      });
      const orphans = devServers.filterOrphans(devServers.listDevServerPids(), killRoots);
      const killReport = devServers.killPids(orphans.map((o) => o.pid));
      report.devServersKilled = killReport.killed;
      // ESRCH / already-dead pids stay in devServerErrors only — do not fail cleanup.
      report.devServerErrors = killReport.errors;
    } catch (err) {
      report.devServersKilled = report.devServersKilled || [];
      report.devServerErrors = report.devServerErrors || [String(err && err.message || err)];
      report.errors.push('dev-server kill: ' + (err.message || err));
    }

    // archive swarm workspace
    if (args['no-archive'] !== 'true') {
      try {
        const src = path.join(registryRoot, 'swarms', swarmId);
        if (fs.existsSync(src)) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const dest = path.join(registryRoot, 'archive-' + stamp, swarmId);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(src, dest);
          report.archived = dest;
          // update registry
          const registry = ensureRegistry(registryRoot);
          registry.swarms = (registry.swarms || []).filter((s) => s.id !== swarmId);
          if (registry.default === swarmId) {
            registry.default = registry.swarms.length === 1 ? registry.swarms[0].id : null;
          }
          fs.writeFileSync(path.join(registryRoot, 'registry.json'), JSON.stringify(registry, null, 2) + '\n');
        }
      } catch (err) {
        report.errors.push('archive: ' + (err.message || err));
      }
    }

    if (args.quiet !== 'true') {
      if (args.json === 'true') console.log(JSON.stringify(report, null, 2));
      else {
        console.log('Cleanup swarm "' + swarmId + '"');
        console.log('  killed: ' + report.killed.length);
        console.log('  worktrees: ' + report.worktreesRemoved.length);
        console.log('  branches: ' + report.branchesDeleted.length);
        if (report.devServersKilled && report.devServersKilled.length) {
          console.log('  dev-servers killed: ' + report.devServersKilled.join(', '));
        }
        if (report.archived) console.log('  archived: ' + report.archived);
        if (report.errors.length) {
          console.log('  errors:');
          for (const e of report.errors) console.log('    - ' + e);
        }
      }
    }
    process.exitCode = report.errors.length ? 1 : 0;
    return report;
  }

  function doctorIssues(repo, opts) {
    const soft = !!(opts && opts.soft);
    const issues = [];
    const info = [];
    const registryRoot = path.join(repo, '.grok-swarm');
    // B5 — collect active mega id for one-liner cleanup hints
    let activeMegaHint = null;
    const mroot = megaRoot(registryRoot);
    if (fs.existsSync(mroot)) {
      for (const id of fs.readdirSync(mroot)) {
        if (id === 'archive' || id.startsWith('archive')) continue;
        const st = loadState(path.join(mroot, id));
        if (st && (st.status === 'running' || st.status === 'queued')) {
          if (!activeMegaHint) activeMegaHint = id;
          if (soft) info.push('mega active (ok): ' + id + ' status=' + st.status);
          else issues.push('mega still running: ' + id + ' — fix: swarm mega cleanup --id ' + id + ' --full');
        }
      }
    }
    const trees = listWorktreesForRepo(repo);
    for (const t of trees) {
      const main = (() => {
        try {
          return execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
        } catch { return repo; }
      })();
      if (path.resolve(t.path) === path.resolve(main)) continue;
      // B5 — one-liner fix commands for orphan worktrees
      const wtFix = 'git -C ' + repo + ' worktree remove ' + JSON.stringify(t.path) + ' --force';
      if (t.branch && t.branch.startsWith('swarm/')) {
        issues.push('leftover worktree: ' + t.path + ' (' + t.branch + ') — fix: ' + wtFix);
      } else if (String(t.path).includes('/.grok/worktrees/')) {
        issues.push('leftover grok worktree: ' + t.path + ' — fix: ' + wtFix);
      }
    }
    // running coordinator
    const coord = readJsonSafe(path.join(registryRoot, 'coordinator.pid'), null);
    if (coord && coord.pid && isProcessAlive(coord.pid)) {
      if (!soft) {
        issues.push(
          'coordinator still running pid ' +
            coord.pid +
            ' — fix: kill ' +
            coord.pid +
            '  # or swarm coordinator stop --repo ' +
            repo,
        );
      } else {
        info.push('coordinator still running pid ' + coord.pid + ' (ok for parallel / soft doctor)');
      }
    }
    // live vite/dev servers over host max_dev_servers
    try {
      const n = devServers.countLiveDevServers();
      const cap = capacityApi.loadHostCapacity(registryRoot);
      const max = Number(cap.max_dev_servers);
      const maxN = Number.isFinite(max) && max >= 0 ? max : 6;
      const cleanupFix = activeMegaHint
        ? 'swarm mega cleanup --id ' + activeMegaHint + ' --full'
        : 'swarm mega cleanup --id <mega-id> --full';
      if (n > maxN) {
        const msg =
          'live vite/dev servers (' +
          n +
          ') exceed max_dev_servers (' +
          maxN +
          ') — fix: ' +
          cleanupFix +
          '  # kills orphan vite on done packs';
        if (soft) info.push(msg);
        else issues.push(msg);
      } else if (n > 0 && soft) {
        info.push(
          'live vite/dev servers: ' +
            n +
            ' (max_dev_servers=' +
            maxN +
            ') — fix if stuck: ' +
            cleanupFix,
        );
      }
    } catch { /* ignore inventory failures */ }
    if (opts && opts.withInfo) return { issues, info };
    return issues;
  }

  function megaDoctor(argv) {
    const args = parseArgs(argv);
    const repo = resolveRepo(args);
    const issues = doctorIssues(repo, {});
    const ok = issues.length === 0;
    if (args.json === 'true') {
      console.log(JSON.stringify({ ok, issues }, null, 2));
    } else if (ok) {
      console.log('OK — field clean for a new swarm/mega');
    } else {
      console.error('Field NOT clean:');
      for (const i of issues) console.error('  - ' + i);
      console.error('Fix with: swarm mega cleanup --id <id> --full  (or swarm cleanup --swarm <id>)');
    }
    // Always non-zero when dirty (pre-flight gate)
    process.exitCode = ok ? 0 : 1;
  }

  function megaCleanup(argv) {
    const args = parseArgs(argv);
    const repo = resolveRepo(args);
    const registryRoot = path.join(repo, '.grok-swarm');
    const megaId = resolveMegaId(args, registryRoot);
    if (!megaId) die('Usage: swarm mega cleanup --id <mega-id> [--full] [--repo PATH] [--json]');
    const dir = megaDir(registryRoot, megaId);
    const state = loadState(dir);
    const plan = loadPlan(dir);
    if (!state) die('No mega state for ' + megaId);

    const report = { megaId, subCleanups: [], integrateBranchDeleted: false, archived: null, errors: [] };

    for (const name of Object.keys(state.subswarms || {})) {
      const sub = state.subswarms[name];
      try {
        // Capture cleanup output without failing the whole mega on one sub error
        const prevExit = process.exitCode;
        cleanupSwarm([
          '--swarm', sub.swarmId,
          '--repo', repo,
          ...(args['keep-branch'] === 'true' ? ['--keep-branch'] : []),
          '--json',
          '--quiet',
        ]);
        process.exitCode = prevExit;
        report.subCleanups.push({ name, swarmId: sub.swarmId, ok: true });
      } catch (err) {
        report.subCleanups.push({ name, swarmId: sub.swarmId, ok: false, error: String(err.message || err) });
        report.errors.push(sub.swarmId + ': ' + (err.message || err));
      }
      state.subswarms[name].status =
        state.subswarms[name].status === 'running' ? 'done' : state.subswarms[name].status;
      state.subswarms[name].finishedAt = Date.now();
    }

    // --full: remove ALL temporary swarm worktrees for this repo (wt-* / sub / integrate)
    // so the field is empty for the next mission. Concurrent unrelated swarms should not share a repo mid-run.
    if (args.full === 'true') {
      report.fullWorktreesRemoved = [];
      // Ensure we are not sitting on a swarm branch (blocks branch -D)
      try {
        const def = (plan && plan.default_branch) || 'master';
        execFileSync('git', ['-C', repo, 'checkout', def], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        try {
          execFileSync('git', ['-C', repo, 'checkout', 'main'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch { /* ignore */ }
      }
      const mainTop = (() => {
        try {
          return path.resolve(execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
        } catch {
          return path.resolve(repo);
        }
      })();
      for (const t of listWorktreesForRepo(repo)) {
        if (!t || typeof t.path !== 'string') continue;
        const top = path.resolve(t.path);
        if (top === mainTop) continue;
        const branch = String(t.branch || '');
        const pathHit =
          top.includes('/.grok/worktrees/') ||
          top.includes(megaId) ||
          Object.values(state.subswarms || {}).some((s) => top.includes(s.swarmId));
        const branchHit =
          branch.startsWith('swarm/wt-') ||
          branch.startsWith('swarm/sub/' + megaId) ||
          branch === (plan && plan.integrate_branch) ||
          branch.startsWith('swarm/integrate/' + megaId);
        if (!pathHit && !branchHit) continue;
        try {
          execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', t.path], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          report.fullWorktreesRemoved.push(t.path);
        } catch {
          try {
            fs.rmSync(t.path, { recursive: true, force: true });
            execFileSync('git', ['-C', repo, 'worktree', 'prune'], { encoding: 'utf8' });
            report.fullWorktreesRemoved.push(t.path + ' (rm+prune)');
          } catch (err2) {
            report.errors.push('full worktree remove: ' + t.path + ' — ' + (err2.message || err2));
          }
        }
      }
      // Delete swarm/wt-*, swarm/sub/<mega>/*, integrate branch
      try {
        const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'swarm/*'], { encoding: 'utf8' })
          .split('\n')
          .map((l) => l.replace(/^\*?\s+/, '').trim())
          .filter(Boolean);
        for (const b of branches) {
          const del =
            b.startsWith('swarm/wt-') ||
            b.startsWith('swarm/sub/' + megaId) ||
            b === (plan && plan.integrate_branch) ||
            b.startsWith('swarm/integrate/' + megaId);
          if (!del) continue;
          try {
            execFileSync('git', ['-C', repo, 'branch', '-D', b], {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            if (plan && b === plan.integrate_branch) report.integrateBranchDeleted = true;
          } catch (err) {
            const msg = String(err.stderr || err.message || err);
            if (!/not found|doesn't exist|unknown/i.test(msg)) {
              report.errors.push('branch -D ' + b + ': ' + msg);
            }
          }
        }
      } catch { /* ignore */ }
      if (plan && plan.integrate_branch && !report.integrateBranchDeleted) {
        report.integrateBranchSkipped = report.integrateBranchSkipped || 'not present';
      }
    }

    state.status = 'cleaned';
    state.updatedAt = Date.now();
    saveState(dir, state);

    // archive mega dir
    if (args.full === 'true') {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = path.join(megaRoot(registryRoot), 'archive', megaId + '-' + stamp);
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(dir, dest);
        report.archived = dest;
      } catch (err) {
        report.errors.push('archive mega: ' + (err.message || err));
      }
    }

    // CLEAN_FIELD marker
    const cleanField = {
      ok: report.errors.length === 0,
      megaId,
      at: Date.now(),
      report,
    };
    writeJsonPretty(path.join(registryRoot, 'CLEAN_FIELD.json'), cleanField);

    // worktree prune
    try {
      execFileSync('git', ['-C', repo, 'worktree', 'prune'], { encoding: 'utf8' });
    } catch { /* ignore */ }

    // Optional Grok CLI worktree GC (default on; soft-fail)
    maybeGrokWorktreeGc(report);

    if (args.json === 'true') console.log(JSON.stringify(report, null, 2));
    else {
      console.log('Mega cleanup: ' + megaId + (args.full === 'true' ? ' --full' : ''));
      console.log('  subswarms cleaned: ' + report.subCleanups.length);
      if (report.archived) console.log('  archived: ' + report.archived);
      if (report.integrateBranchDeleted) console.log('  integrate branch deleted');
      if (report.grokWorktreeGc) console.log('  ' + report.grokWorktreeGc);
      if (report.errors.length) {
        for (const e of report.errors) console.log('  error: ' + e);
      }
      console.log('Verify: swarm mega doctor --expect-clean --repo ' + repo);
    }
    process.exitCode = report.errors.length ? 1 : 0;
  }

  function megaMark(argv) {
    // Helper for coordinators/meta: mark subswarm status
    const args = parseArgs(argv);
    const repo = resolveRepo(args);
    const registryRoot = path.join(repo, '.grok-swarm');
    const megaId = resolveMegaId(args, registryRoot);
    if (!megaId) die('Usage: swarm mega mark --id <mega> --sub <name> --status done|running|blocked|queued [--note "..."] [--force]');
    const sub = args.sub && args.sub !== 'true' ? args.sub : null;
    const status = args.status && args.status !== 'true' ? args.status : null;
    if (!sub || !status) die('Need --sub and --status');
    if (!SUB_STATUSES.has(status)) die('Invalid status: ' + status);
    const dir = megaDir(registryRoot, megaId);
    const state = loadState(dir);
    if (!state || !state.subswarms[sub]) die('Unknown subswarm: ' + sub);

    // Hard visual gate when marking done (skip for gates_only tiers)
    const markSub = state.subswarms[sub];
    const markTier = resolveVisualTier(markSub);
    const needsVisual = shouldRequireReviewResult(markTier);
    if (status === 'done' && needsVisual && args.force !== 'true') {
      if (args['force-visual-pass'] === 'true') {
        megaRuntime.writeVisualPass(registryRoot, markSub.swarmId, 'force-visual-pass on mark');
      }
      const gate = megaRuntime.checkVisualGate(registryRoot, markSub.swarmId, {
        required: true,
      });
      if (!gate.ok) {
        console.error('Refusing mark done: ' + gate.reason);
        console.error('Run visual reviewer or: swarm mega visual pass --id ' + megaId + ' --sub ' + sub);
        console.error('Override: --force or --force-visual-pass');
        process.exit(1);
      }
    }

    state.subswarms[sub].status = status;
    if (args.note && args.note !== 'true') state.subswarms[sub].note = args.note;
    if (status === 'done' || status === 'failed' || status === 'cancelled' || status === 'blocked') {
      state.subswarms[sub].finishedAt = Date.now();
    }
    state.updatedAt = Date.now();
    // Packs done → completed (unless already merge_blocked / integrated / merged)
    const allDone = Object.values(state.subswarms).every((s) =>
      s.status === 'done' || s.status === 'cancelled');
    if (allDone) {
      const sticky = new Set(['merge_blocked', 'integrated', 'merged']);
      if (!sticky.has(state.status)) state.status = 'completed';
    }
    saveState(dir, state);
    console.log('Marked ' + megaId + '/' + sub + ' → ' + status);
  }

  const api = {
    megaCommand: null,
    cleanupSwarm,
    validatePlan,
    DEFAULT_CAPACITY,
    doctorIssues,
    megaLaunch,
    megaCleanup,
    megaMark,
  };

  megaRuntime.attachRuntimeCommands(api, {
    die,
    parseArgs,
    skillRootDir,
    buildWorkspace,
    readState,
    launchCommand,
    validatePlan,
    megaLaunchFn: megaLaunch,
    megaCleanupFn: megaCleanup,
    reconcileDeadDispatches: ctx.reconcileDeadDispatches,
  });

  function megaCommand(argv) {
    const args = parseArgs(argv);
    const sub = args._[0] || '';
    const rest = argv.slice(1);
    if (sub === 'write-plan' || sub === 'plan') return megaWritePlan(rest);
    if (sub === 'check') return megaCheck(rest);
    if (sub === 'status') return megaStatus(rest);
    if (sub === 'watch') {
      // Alias: mega status + coordinator status --all (implemented in swarm.cjs watchCommand)
      if (typeof ctx.watchCommand === 'function') {
        return ctx.watchCommand(rest);
      }
      die('Internal: watchCommand not wired for mega watch');
    }
    if (sub === 'launch') return megaLaunch(rest);
    if (sub === 'cleanup') return megaCleanup(rest);
    if (sub === 'doctor') return megaDoctor(rest);
    if (sub === 'mark') return megaMark(rest);
    if (sub === 'visual') return api.megaVisual(rest);
    if (sub === 'merge') return api.megaMerge(rest);
    if (sub === 'propose' || sub === 'propose-plan') return api.megaPropose(rest);
    if (sub === 'tick') return api.megaTick(rest);
    if (sub === 'run') return api.megaRun(rest);
    die(
      'Usage: swarm mega <cmd> ...\n' +
      '  write-plan --plan plan.json\n' +
      '  propose --repo PATH [--goal "..."] [--roots src/features,src/components] [--out plan.json]\n' +
      '  check|status|watch|launch|mark|cleanup|doctor --id <mega-id>\n' +
      '  watch [= swarm watch <mega-id>]: mega status + coordinator status --all\n' +
      '  visual check|pass --id <mega> --sub <name>\n' +
      '  merge --id <mega> [--to-main] [--gates "cmd"] [--skip-visual-gate]\n' +
      '  tick --id <mega> [--force-visual-pass] [--auto-merge]\n' +
      '  run --id <mega> [--daemon] [--loop] [--interval 20] [--auto-merge] [--to-main] [--auto-cleanup]\n' +
      '  run --id <mega> --stop | --status\n' +
      'Also: swarm cleanup --swarm <id>',
    );
  }

  api.megaCommand = megaCommand;

  return api;
}

module.exports = {
  createMegaCommands,
  validatePlan,
  DEFAULT_CAPACITY,
  pathsOverlap,
  findLeaseConflicts,
  checkVisualGate: megaRuntime.checkVisualGate,
  mergeIntegrate: megaRuntime.mergeIntegrate,
  proposePlan: megaRuntime.proposePlan,
  queuedReason: megaRuntime.queuedReason,
};
