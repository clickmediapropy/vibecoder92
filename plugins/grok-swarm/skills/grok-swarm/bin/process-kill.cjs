/**
 * Process tree + cmdline scavenger for grok-swarm pause/cleanup.
 * Zero third-party deps. Prefer process groups when present; always walk children.
 */
'use strict';

const { execFileSync } = require('child_process');

function isAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Immediate children of pid (Linux pgrep -P).
 * @param {number} pid
 * @returns {number[]}
 */
function listChildren(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return [];
  try {
    const out = execFileSync('pgrep', ['-P', String(n)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .trim()
      .split(/\s+/)
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x) && x > 0);
  } catch {
    return [];
  }
}

/**
 * Depth-first collect of pid + descendants.
 * @param {number} rootPid
 * @returns {number[]}
 */
function collectTree(rootPid) {
  const seen = new Set();
  const stack = [Number(rootPid)];
  while (stack.length) {
    const p = stack.pop();
    if (!Number.isFinite(p) || p <= 0 || seen.has(p)) continue;
    seen.add(p);
    for (const c of listChildren(p)) stack.push(c);
  }
  return [...seen];
}

/**
 * SIGTERM (or signal) every process in the tree (children first), then optional SIGKILL after grace.
 * @param {number} pid
 * @param {{ signal?: string, escalateMs?: number, alsoKillPg?: boolean }} [opts]
 * @returns {{ killed: number[], errors: string[], signal: string }}
 */
function killProcessTree(pid, opts) {
  const o = opts || {};
  const signal = o.signal || 'SIGTERM';
  const escalateMs = o.escalateMs == null ? 1500 : Number(o.escalateMs);
  const killed = [];
  const errors = [];
  const tree = collectTree(pid);
  // children first (reverse of DFS insert — kill leaves then root)
  const ordered = tree.slice().reverse();

  if (o.alsoKillPg !== false && Number.isFinite(Number(pid)) && Number(pid) > 0) {
    try {
      // negative pid = process group (only works if leader / setsid)
      process.kill(-Number(pid), signal);
    } catch {
      /* not a pg leader or ESRCH */
    }
  }

  for (const p of ordered) {
    try {
      process.kill(p, signal);
      killed.push(p);
    } catch (err) {
      errors.push(String(p) + ': ' + (err && err.message ? err.message : err));
    }
  }

  if (escalateMs > 0) {
    const start = Date.now();
    while (Date.now() - start < escalateMs) {
      const still = tree.filter(isAlive);
      if (!still.length) break;
      // busy-wait short; pause paths are not latency-critical
      try {
        execFileSync('sleep', ['0.05'], { stdio: 'ignore' });
      } catch {
        break;
      }
    }
    for (const p of tree) {
      if (!isAlive(p)) continue;
      try {
        process.kill(p, 'SIGKILL');
        if (!killed.includes(p)) killed.push(p);
      } catch (err) {
        errors.push(String(p) + ' KILL: ' + (err && err.message ? err.message : err));
      }
    }
  }

  return { killed, errors, signal };
}

/**
 * Parse `ps -eo pid=,args=` into records.
 * @returns {Array<{ pid: number, cmd: string }>}
 */
function listAllProcesses() {
  let text = '';
  try {
    text = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const m = String(line)
      .trim()
      .match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    out.push({ pid: Number(m[1]), cmd: m[2] });
  }
  return out;
}

/**
 * Match host processes that are clearly swarm worker / gate orphans for a repo.
 * Safe heuristics only — never match MAIN-only node without worktree/tmp markers.
 *
 * @param {{
 *   repoBasename?: string,
 *   worktreePaths?: string[],
 *   extraSubstrings?: string[],
 * }} [opts]
 * @returns {Array<{ pid: number, cmd: string, reason: string }>}
 */
function listSwarmWorkerOrphans(opts) {
  const o = opts || {};
  const base = o.repoBasename ? String(o.repoBasename).trim() : '';
  const wts = (o.worktreePaths || [])
    .map((p) => String(p || '').replace(/\/+$/, ''))
    .filter(Boolean);
  const extra = (o.extraSubstrings || []).map(String).filter(Boolean);
  const procs = listAllProcesses();
  const hits = [];

  for (const p of procs) {
    const cmd = p.cmd || '';
    if (!cmd || p.pid === process.pid) continue;
    // Never scavenge the swarm CLI / node test runners themselves
    if (/swarm\.cjs\b|process-kill\.cjs\b|node --test\b|pause-all\.test/.test(cmd)) continue;
    if (p.pid === process.ppid) continue;

    // Grok builders launched for swarm (prompt files under /tmp/grok-swarm*)
    // Require the grok binary + a swarm prompt file (not arbitrary grok -m sessions)
    if (
      /\/\.grok\/bin\/grok\b/.test(cmd) &&
      /--prompt-file\s+\/tmp\/grok-swarm/.test(cmd)
    ) {
      hits.push({ ...p, reason: 'grok-swarm-prompt' });
      continue;
    }

    // Any cmdline under known worktree path
    const hitWt = wts.find((w) => cmd.includes(w));
    if (hitWt) {
      // Heavy gates only — do not kill random long-lived tools without markers
      if (
        /npm\s+install|npm\s+ci|tsc\b|vitest|verify-ui-policy|ui:policy|esbuild|vite\b|webpack|oxlint|oxfmt/.test(
          cmd,
        )
      ) {
        hits.push({ ...p, reason: 'worktree-gate:' + hitWt });
        continue;
      }
    }

    // Worktree layout for this repo basename even without explicit path list
    if (base && cmd.includes('/.grok/worktrees/repos-' + base + '/')) {
      if (
        /npm\s+install|npm\s+ci|tsc\b|vitest|verify-ui-policy|ui:policy|esbuild|vite\b/.test(cmd)
      ) {
        hits.push({ ...p, reason: 'repos-' + base + '-gate' });
        continue;
      }
    }

    for (const s of extra) {
      if (s && cmd.includes(s)) {
        hits.push({ ...p, reason: 'extra:' + s });
        break;
      }
    }
  }

  // de-dupe by pid
  const byPid = new Map();
  for (const h of hits) byPid.set(h.pid, h);
  return [...byPid.values()];
}

/**
 * Kill orphan swarm workers/gates for a repo.
 * @param {object} opts same as listSwarmWorkerOrphans + escalateMs
 * @returns {{ targets: Array, trees: Array }}
 */
function killSwarmWorkerOrphans(opts) {
  const targets = listSwarmWorkerOrphans(opts);
  const trees = [];
  for (const t of targets) {
    trees.push({
      pid: t.pid,
      reason: t.reason,
      cmd: t.cmd.slice(0, 200),
      result: killProcessTree(t.pid, { escalateMs: (opts && opts.escalateMs) || 1200 }),
    });
  }
  return { targets, trees };
}

module.exports = {
  isAlive,
  listChildren,
  collectTree,
  killProcessTree,
  listAllProcesses,
  listSwarmWorkerOrphans,
  killSwarmWorkerOrphans,
};
