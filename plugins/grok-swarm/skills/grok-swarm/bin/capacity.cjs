/**
 * Host-level capacity + cross-mega lease helpers for grok-swarm.
 * Shared across concurrent megas on one repo/.grok-swarm registry.
 * Zero third-party deps.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const devServers = require('./dev-servers.cjs');

/** High defaults for ~20 micro-pack teams on one host. Raise/lower via host-capacity.json.
 * Canonical values also in templates/host-capacity.default.json — keep in sync. */
const HOST_DEFAULT_CAPACITY = {
  max_coordinators: 16,
  max_builders: 30,
  max_reviewers: 15,
  max_scouts: 10,
  max_loggers: 6,
  max_visual_reviewers: 8,
  max_dev_servers: 10,
  /** Concurrent heavy gate subprocesses (tsc, vitest, npm install, builds) via bin/gate.cjs. */
  max_heavy_tools: 3,
  ram_reserve_gb: 4,
  /** Auto-pause all swarms when MemAvailable falls below this (GB). Dashboard/watch enforce. */
  min_free_ram_gb: 2,
  /** 1 = on, 0 = off. Off by default on this host (Nico's Mac runs chronically low on RAM;
   * auto-pause was killing healthy swarms). Re-enable per-repo via host-capacity.json. */
  auto_pause_low_memory: 0,
};

/** Per-mega plan defaults (can be lower than host; never used as a hard skill law). */
const MEGA_DEFAULT_CAPACITY = {
  max_builders: 30,
  max_coordinators: 16,
  max_reviewers: 12,
  max_scouts: 8,
  max_loggers: 4,
  max_visual_reviewers: 8,
  max_dev_servers: 10,
  ram_reserve_gb: 4,
};

/** Five swarm roles: orchestrate · discover · implement · audit · compound learnings */
const AGENT_ROLES = new Set(['coordinator', 'builder', 'reviewer', 'scout', 'logger']);

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

function isAlive(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function hostCapacityPath(registryRoot) {
  return path.join(registryRoot, 'host-capacity.json');
}

function loadHostCapacity(registryRoot) {
  const file = hostCapacityPath(registryRoot);
  const raw = readJsonSafe(file, null);
  return { ...HOST_DEFAULT_CAPACITY, ...(raw || {}) };
}

function saveHostCapacity(registryRoot, patch) {
  const cur = loadHostCapacity(registryRoot);
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined || v === null) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) continue;
    next[k] = n;
  }
  writeJsonPretty(hostCapacityPath(registryRoot), next);
  return next;
}

function listMegaDirs(registryRoot) {
  const root = path.join(registryRoot, 'mega');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((id) => id !== 'archive' && !id.startsWith('archive'))
    .map((id) => ({
      megaId: id,
      dir: path.join(root, id),
      state: readJsonSafe(path.join(root, id, 'state.json'), null),
      plan: readJsonSafe(path.join(root, id, 'plan.json'), null),
      leases: readJsonSafe(path.join(root, id, 'leases.json'), null),
    }))
    .filter((m) => m.state);
}

function isMegaActive(state) {
  if (!state) return false;
  const st = String(state.status || '').toLowerCase();
  return st === 'running' || st === 'queued';
}

/**
 * Infer role from agent label when dispatch.role missing.
 */
function inferRoleFromLabel(label) {
  const s = String(label || '').toLowerCase();
  if (/logger|learning|compound/.test(s)) return 'logger';
  if (/scout/.test(s)) return 'scout';
  if (/visual\s*reviewer|reviewer/.test(s)) return 'reviewer';
  if (/coordinator/.test(s)) return 'coordinator';
  if (/builder/.test(s)) return 'builder';
  return 'builder';
}

function countLiveDispatches(registryRoot, swarmId) {
  const dir = path.join(registryRoot, 'swarms', swarmId, 'dispatches');
  const counts = { builder: 0, reviewer: 0, scout: 0, logger: 0, visual: 0, other: 0 };
  if (!fs.existsSync(dir)) return counts;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const rec = readJsonSafe(path.join(dir, f), null);
    if (!rec || rec.status !== 'running') continue;
    if (rec.pid && !isAlive(rec.pid)) continue;
    if (!rec.pid) continue; // unknown liveness — skip for free-slot math
    const role = rec.role || inferRoleFromLabel(rec.agentLabel);
    const label = String(rec.agentLabel || '');
    if (/visual/i.test(label)) counts.visual++;
    if (role === 'builder') counts.builder++;
    else if (role === 'reviewer') counts.reviewer++;
    else if (role === 'scout') counts.scout++;
    else if (role === 'logger') counts.logger++;
    else counts.other++;
  }
  return counts;
}

function coordinatorAlive(registryRoot, swarmId) {
  const file = path.join(registryRoot, 'swarms', swarmId, 'coordinator.pid');
  const rec = readJsonSafe(file, null);
  return !!(rec && isAlive(rec.pid));
}

/**
 * Live usage across all active megas on this host registry.
 */
function measureHostUsage(registryRoot) {
  const usage = {
    coordinators: 0,
    builders: 0,
    reviewers: 0,
    scouts: 0,
    loggers: 0,
    visual_reviewers: 0,
    megas: [],
  };
  for (const m of listMegaDirs(registryRoot)) {
    if (!isMegaActive(m.state)) continue;
    const megaEntry = {
      megaId: m.megaId,
      status: m.state.status,
      runningSubs: 0,
      coordinators: 0,
      builders: 0,
      reviewers: 0,
      scouts: 0,
      loggers: 0,
    };
    for (const [name, sub] of Object.entries(m.state.subswarms || {})) {
      if (sub.status !== 'running' && sub.status !== 'queued') continue;
      if (sub.status === 'running') {
        megaEntry.runningSubs++;
        const sid = sub.swarmId;
        if (sid && coordinatorAlive(registryRoot, sid)) {
          usage.coordinators++;
          megaEntry.coordinators++;
        } else if (sid && sub.status === 'running') {
          // count reserved slot for running sub even if coord pid missing (launch race)
          usage.coordinators++;
          megaEntry.coordinators++;
        }
        if (sid) {
          const d = countLiveDispatches(registryRoot, sid);
          usage.builders += d.builder;
          usage.reviewers += d.reviewer;
          usage.scouts += d.scout;
          usage.loggers += d.logger || 0;
          usage.visual_reviewers += d.visual;
          megaEntry.builders += d.builder;
          megaEntry.reviewers += d.reviewer;
          megaEntry.scouts += d.scout;
          megaEntry.loggers += d.logger || 0;
        }
      }
    }
    usage.megas.push(megaEntry);
  }
  return usage;
}

function freeHostSlots(registryRoot, planCapacity) {
  const host = loadHostCapacity(registryRoot);
  const usage = measureHostUsage(registryRoot);
  // Effective ceiling: min(host, plan) when plan provided
  const plan = planCapacity || {};
  const ceiling = {
    max_coordinators: Math.min(
      host.max_coordinators,
      plan.max_coordinators != null ? plan.max_coordinators : host.max_coordinators,
    ),
    max_builders: Math.min(
      host.max_builders,
      plan.max_builders != null ? plan.max_builders : host.max_builders,
    ),
    max_reviewers: Math.min(
      host.max_reviewers,
      plan.max_reviewers != null ? plan.max_reviewers : host.max_reviewers,
    ),
    max_scouts: Math.min(
      host.max_scouts || HOST_DEFAULT_CAPACITY.max_scouts,
      plan.max_scouts != null ? plan.max_scouts : host.max_scouts || HOST_DEFAULT_CAPACITY.max_scouts,
    ),
    max_loggers: Math.min(
      host.max_loggers || HOST_DEFAULT_CAPACITY.max_loggers,
      plan.max_loggers != null ? plan.max_loggers : host.max_loggers || HOST_DEFAULT_CAPACITY.max_loggers,
    ),
    max_visual_reviewers: Math.min(
      host.max_visual_reviewers,
      plan.max_visual_reviewers != null ? plan.max_visual_reviewers : host.max_visual_reviewers,
    ),
  };
  return {
    host,
    usage,
    ceiling,
    free: {
      coordinators: Math.max(0, ceiling.max_coordinators - usage.coordinators),
      builders: Math.max(0, ceiling.max_builders - usage.builders),
      reviewers: Math.max(0, ceiling.max_reviewers - usage.reviewers),
      scouts: Math.max(0, (ceiling.max_scouts || 0) - usage.scouts),
      loggers: Math.max(0, (ceiling.max_loggers || 0) - (usage.loggers || 0)),
      visual_reviewers: Math.max(0, ceiling.max_visual_reviewers - usage.visual_reviewers),
    },
  };
}

// --- path / lease helpers (shared with mega; keep in sync with mega.cjs) ---

function stripLeaseGlob(p) {
  let s = String(p || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  if (s.endsWith('/**')) s = s.slice(0, -3);
  else if (s.endsWith('/*')) s = s.slice(0, -2);
  else if (s.endsWith('/**/*')) s = s.slice(0, -5);
  return s.replace(/\/+$/, '');
}

function isSegmentPathPrefix(parent, child) {
  if (parent === child) return true;
  if (!parent || !child) return false;
  return child.startsWith(parent.endsWith('/') ? parent : parent + '/');
}

function pathsOverlap(a, b) {
  const na = stripLeaseGlob(a);
  const nb = stripLeaseGlob(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return isSegmentPathPrefix(na, nb) || isSegmentPathPrefix(nb, na);
}

function normalizeFiles(files) {
  if (!Array.isArray(files)) return [];
  const out = [];
  const seen = new Set();
  for (const f of files) {
    const s = String(f || '')
      .trim()
      .replace(/\\/g, '/');
    if (!s || s.includes('..')) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * Find file lease overlaps between this plan's subswarms and other active megas.
 */
function findCrossMegaLeaseConflicts(registryRoot, plan, { excludeMegaId } = {}) {
  const problems = [];
  const myId = plan && plan.id;
  const mySubs = (plan && plan.subswarms) || [];
  const myFiles = [];
  for (const s of mySubs) {
    for (const f of normalizeFiles(s.files)) {
      myFiles.push({ sub: s.name, file: f });
    }
  }

  for (const m of listMegaDirs(registryRoot)) {
    if (!isMegaActive(m.state)) continue;
    if (excludeMegaId && m.megaId === excludeMegaId) continue;
    if (myId && m.megaId === myId) continue;

    const peerFiles = [];
    // Prefer live state subswarms, else plan, else leases.json
    const subs = m.state.subswarms || {};
    for (const [name, sub] of Object.entries(subs)) {
      if (['done', 'cancelled', 'failed'].includes(sub.status)) continue;
      for (const f of normalizeFiles(sub.files || (m.leases && m.leases[name] && m.leases[name].files))) {
        peerFiles.push({ megaId: m.megaId, sub: name, file: f, status: sub.status });
      }
    }
    if (!peerFiles.length && m.plan && m.plan.subswarms) {
      for (const s of m.plan.subswarms) {
        for (const f of normalizeFiles(s.files)) {
          peerFiles.push({ megaId: m.megaId, sub: s.name, file: f, status: 'plan' });
        }
      }
    }

    for (const mine of myFiles) {
      for (const peer of peerFiles) {
        if (pathsOverlap(mine.file, peer.file)) {
          problems.push({
            kind: 'cross-mega-lease-overlap',
            megaId: peer.megaId,
            subswarms: [mine.sub, peer.sub],
            files: [mine.file + ' ∩ ' + peer.file],
            message:
              'Lease clash with active mega "' +
              peer.megaId +
              '": ' +
              mine.sub +
              ' (' +
              mine.file +
              ') overlaps ' +
              peer.sub +
              ' (' +
              peer.file +
              ')',
          });
        }
      }
    }
  }

  // Dedupe messages
  const seen = new Set();
  return problems.filter((p) => {
    if (seen.has(p.message)) return false;
    seen.add(p.message);
    return true;
  });
}

/**
 * True when a normalized lease path is under src/ (frontend tree).
 * After stripLeaseGlob: `src`, `src/features/**` → true; `convex/**` → false.
 * @param {string} file
 * @returns {boolean}
 */
function isSrcFrontendLease(file) {
  const n = stripLeaseGlob(file);
  if (!n) return false;
  return n === 'src' || n.startsWith('src/');
}

/**
 * Collect active (non-terminal) file leases from a mega dir entry.
 * Prefer live state subswarms, else plan, else leases.json.
 */
function peerActiveFiles(m) {
  const peerFiles = [];
  const subs = (m.state && m.state.subswarms) || {};
  for (const [name, sub] of Object.entries(subs)) {
    if (['done', 'cancelled', 'failed'].includes(sub.status)) continue;
    for (const f of normalizeFiles(
      sub.files || (m.leases && m.leases[name] && m.leases[name].files),
    )) {
      peerFiles.push({ megaId: m.megaId, sub: name, file: f, status: sub.status });
    }
  }
  if (!peerFiles.length && m.plan && m.plan.subswarms) {
    for (const s of m.plan.subswarms) {
      for (const f of normalizeFiles(s.files)) {
        peerFiles.push({ megaId: m.megaId, sub: s.name, file: f, status: 'plan' });
      }
    }
  }
  return peerFiles;
}

/**
 * Dual-FE thrash detector (E3): this plan has ≥1 lease under src/ AND another
 * active mega also has ≥1 src/ lease — even if paths are disjoint
 * (e.g. src/features/a vs src/features/b). Path-overlap is findCrossMegaLeaseConflicts.
 * mega check/launch should treat kind `dual-fe-mega-clash` as a hard problem unless --force.
 *
 * @param {string} registryRoot
 * @param {{ id?: string, subswarms?: Array<{ name: string, files?: string[] }> }} plan
 * @param {{ excludeMegaId?: string }} [opts]
 * @returns {Array<{ kind: string, megaId: string, message: string, files?: string[] }>}
 */
function findDualFeMegaConflicts(registryRoot, plan, { excludeMegaId } = {}) {
  const myId = plan && plan.id;
  const mySubs = (plan && plan.subswarms) || [];
  const mySrc = [];
  for (const s of mySubs) {
    for (const f of normalizeFiles(s.files)) {
      if (isSrcFrontendLease(f)) mySrc.push({ sub: s.name, file: f });
    }
  }
  if (!mySrc.length) return [];

  const problems = [];
  for (const m of listMegaDirs(registryRoot)) {
    if (!isMegaActive(m.state)) continue;
    if (excludeMegaId && m.megaId === excludeMegaId) continue;
    if (myId && m.megaId === myId) continue;

    const peerSrc = peerActiveFiles(m).filter((p) => isSrcFrontendLease(p.file));
    if (!peerSrc.length) continue;

    problems.push({
      kind: 'dual-fe-mega-clash',
      megaId: m.megaId,
      files: peerSrc.map((p) => p.file).slice(0, 8),
      message:
        'Dual FE mega clash with active mega "' +
        m.megaId +
        '": both lease under src/ (prefer one FE mega per host; use --force to override)',
    });
  }

  const seen = new Set();
  return problems.filter((p) => {
    const key = p.kind + ':' + p.megaId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Pure helper: live vite count exceeds host max_dev_servers (E2).
 * mega launch can refuse new visual when true unless --force.
 * @param {number} live
 * @param {number|null|undefined} maxDevServers
 * @returns {boolean}
 */
function isDevServersOverCapacity(live, maxDevServers) {
  const max = maxDevServers != null ? Number(maxDevServers) : HOST_DEFAULT_CAPACITY.max_dev_servers;
  if (!Number.isFinite(max)) return false;
  return Number(live) > max;
}

function capacityCommand(ctx, argv) {
  const args = ctx.parseArgs(argv);
  const repo =
    (args.repo && args.repo !== 'true' ? path.resolve(args.repo) : null) ||
    (args.cwd && args.cwd !== 'true' ? path.resolve(args.cwd) : null) ||
    process.cwd();
  const registryRoot = path.join(repo, '.grok-swarm');
  if (!fs.existsSync(registryRoot)) {
    ctx.die('No .grok-swarm in ' + repo);
  }

  const sub = args._[0] || 'show';

  if (sub === 'set') {
    const patch = {};
    const map = {
      'max-coordinators': 'max_coordinators',
      'max-builders': 'max_builders',
      'max-reviewers': 'max_reviewers',
      'max-scouts': 'max_scouts',
      'max-loggers': 'max_loggers',
      'max-visual-reviewers': 'max_visual_reviewers',
      'max-dev-servers': 'max_dev_servers',
      'max-heavy-tools': 'max_heavy_tools',
      'ram-reserve-gb': 'ram_reserve_gb',
    };
    for (const [flag, key] of Object.entries(map)) {
      if (args[flag] !== undefined && args[flag] !== 'true') patch[key] = args[flag];
    }
    // also accept underscore forms
    for (const key of Object.values(map)) {
      if (args[key] !== undefined && args[key] !== 'true') patch[key] = args[key];
    }
    if (!Object.keys(patch).length) {
      ctx.die(
        'Usage: swarm capacity set --max-coordinators N --max-builders N --max-reviewers N --max-scouts N ...',
      );
    }
    const next = saveHostCapacity(registryRoot, patch);
    if (args.json === 'true') console.log(JSON.stringify({ ok: true, host: next }, null, 2));
    else {
      console.log('Host capacity updated: ' + hostCapacityPath(registryRoot));
      for (const [k, v] of Object.entries(next)) console.log('  ' + k + '=' + v);
    }
    return;
  }

  // show (default) — E4: scope vite count to this repo basename; E2: warn if live > max
  const slots = freeHostSlots(registryRoot, null);
  const repoBasename = path.basename(repo);
  const maxDev =
    slots.host.max_dev_servers != null
      ? slots.host.max_dev_servers
      : HOST_DEFAULT_CAPACITY.max_dev_servers;
  const dev_servers_live = devServers.countLiveDevServers({ repoBasename });
  const dev_servers_over_capacity = isDevServersOverCapacity(dev_servers_live, maxDev);
  const warnings = [];
  if (dev_servers_over_capacity) {
    warnings.push(
      'dev servers live (' +
        dev_servers_live +
        ') > max_dev_servers (' +
        maxDev +
        ') — visual may be flaky; free vites or raise max_dev_servers',
    );
  }

  if (args.json === 'true') {
    console.log(
      JSON.stringify(
        {
          repo,
          registryRoot,
          ...slots,
          dev_servers_live,
          dev_servers_over_capacity,
          warnings,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log('Host capacity — ' + repo);
  console.log(
    '  ceiling  coord≤' +
      slots.host.max_coordinators +
      '  builders≤' +
      slots.host.max_builders +
      '  reviewers≤' +
      slots.host.max_reviewers +
      '  scouts≤' +
      (slots.host.max_scouts || 0) +
      '  loggers≤' +
      (slots.host.max_loggers || 0) +
      '  visual≤' +
      slots.host.max_visual_reviewers,
  );
  console.log(
    '  in use   coord=' +
      slots.usage.coordinators +
      '  builders=' +
      slots.usage.builders +
      '  reviewers=' +
      slots.usage.reviewers +
      '  scouts=' +
      slots.usage.scouts +
      '  loggers=' +
      (slots.usage.loggers || 0) +
      '  visual=' +
      slots.usage.visual_reviewers,
  );
  console.log(
    '  free     coord=' +
      slots.free.coordinators +
      '  builders=' +
      slots.free.builders +
      '  reviewers=' +
      slots.free.reviewers +
      '  scouts=' +
      slots.free.scouts +
      '  loggers=' +
      (slots.free.loggers || 0) +
      '  visual=' +
      slots.free.visual_reviewers,
  );
  if (slots.usage.megas.length) {
    console.log('  active megas:');
    for (const m of slots.usage.megas) {
      console.log(
        '    ' +
          m.megaId +
          ' [' +
          m.status +
          '] running_subs=' +
          m.runningSubs +
          ' coords≈' +
          m.coordinators,
      );
    }
  } else {
    console.log('  active megas: (none)');
  }
  console.log(
    '  dev servers live=' +
      dev_servers_live +
      '  max_dev_servers=' +
      maxDev +
      '  (repo=' +
      repoBasename +
      ')',
  );
  if (dev_servers_over_capacity) {
    console.log('  WARN: ' + warnings[0]);
  }
  console.log('  file: ' + hostCapacityPath(registryRoot));
  console.log('  set:  swarm capacity set --max-coordinators 10 --max-builders 30 ...');
}

module.exports = {
  HOST_DEFAULT_CAPACITY,
  MEGA_DEFAULT_CAPACITY,
  AGENT_ROLES,
  loadHostCapacity,
  saveHostCapacity,
  hostCapacityPath,
  measureHostUsage,
  freeHostSlots,
  findCrossMegaLeaseConflicts,
  findDualFeMegaConflicts,
  isSrcFrontendLease,
  isDevServersOverCapacity,
  pathsOverlap,
  stripLeaseGlob,
  normalizeFiles,
  listMegaDirs,
  isMegaActive,
  inferRoleFromLabel,
  capacityCommand,
};
