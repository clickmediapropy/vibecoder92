/**
 * Dev-server inventory + orphan Vite kill helpers for grok-swarm.
 * Zero third-party deps. Safe rule: only kill PIDs whose cmdline includes a
 * finished worktree path — never MAIN repo processes without that match.
 */
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Parse `ps -eo pid=,args=` style lines into vite/dev-server process records.
 * Skips pure `esbuild --service` children (prefer the vite parent).
 * @param {string[]} lines
 * @returns {Array<{ pid: number, cmd: string, worktreeHint?: string }>}
 */
function parsePsLines(lines) {
  const out = [];
  for (const line of lines || []) {
    const m = String(line)
      .trim()
      .match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const cmd = m[2];
    if (!/vite|esbuild --service/i.test(cmd)) continue;
    // Prefer vite parent; skip pure esbuild service unless cmdline also has vite
    if (/esbuild --service/i.test(cmd) && !/vite/i.test(cmd)) continue;
    const rec = { pid: Number(m[1]), cmd };
    const hint = extractWorktreeHint(cmd);
    if (hint) rec.worktreeHint = hint;
    out.push(rec);
  }
  return out;
}

/**
 * Best-effort worktree path from a process cmdline.
 * @param {string} cmd
 * @returns {string|undefined}
 */
function extractWorktreeHint(cmd) {
  const s = String(cmd || '');
  const grok = s.match(
    /(\/[^\s]*\/\.grok\/worktrees\/[^\s]+?)(?:\/node_modules|\s|$)/,
  );
  if (grok) return grok[1].replace(/\/+$/, '');
  const wt = s.match(/(\/[^\s]*\/wt-[A-Za-z0-9._-]+)/);
  if (wt) return wt[1].replace(/\/+$/, '');
  return undefined;
}

/**
 * List live vite (and vite-tagged) processes on the host.
 * @param {{ repoBasename?: string }} [opts]
 * @returns {Array<{ pid: number, cmd: string, worktreeHint?: string }>}
 */
function listDevServerPids(opts) {
  let text = '';
  try {
    text = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  let list = parsePsLines(text.split('\n'));
  const base =
    opts && opts.repoBasename != null && String(opts.repoBasename).trim()
      ? String(opts.repoBasename).trim()
      : '';
  if (base) {
    // Match worktree layout (repos-<basename>) or bare basename in path
    list = list.filter(
      (p) =>
        p.cmd.includes(base) ||
        p.cmd.includes('repos-' + base) ||
        (p.worktreeHint && p.worktreeHint.includes(base)),
    );
  }
  return list;
}

/**
 * Keep only processes whose cmdline includes a finished worktree path.
 * Never matches MAIN solely by basename unless that absolute path is listed.
 * @param {Array<{ pid: number, cmd: string }>} procs
 * @param {string[]} doneWorktreePaths
 * @returns {Array<{ pid: number, cmd: string, worktreeHint?: string }>}
 */
function filterOrphans(procs, doneWorktreePaths) {
  const roots = (doneWorktreePaths || [])
    .map((p) => String(p || '').replace(/\/+$/, ''))
    .filter(Boolean);
  if (!roots.length) return [];
  return (procs || []).filter((p) => {
    const cmd = String((p && p.cmd) || '');
    return roots.some((r) => cmd.includes(r));
  });
}

/**
 * @param {{ repo?: string, doneWorktreePaths?: string[] }} opts
 * @returns {Array<{ pid: number, cmd: string, worktreeHint?: string }>}
 */
function listOrphanDevServers(opts) {
  const o = opts || {};
  const repo = o.repo;
  const base = repo ? path.basename(String(repo)) : undefined;
  return filterOrphans(listDevServerPids({ repoBasename: base }), o.doneWorktreePaths || []);
}

/**
 * @param {number[]} pids
 * @param {string} [signal]
 * @returns {{ killed: number[], errors: string[] }}
 */
function killPids(pids, signal) {
  const killed = [];
  const errors = [];
  const sig = signal || 'SIGTERM';
  for (const pid of pids || []) {
    const n = Number(pid);
    if (!Number.isFinite(n) || n <= 0) {
      errors.push(String(pid) + ': invalid pid');
      continue;
    }
    try {
      process.kill(n, sig);
      killed.push(n);
    } catch (err) {
      errors.push(String(n) + ': ' + (err && err.message ? err.message : err));
    }
  }
  return { killed, errors };
}

/**
 * Count live vite processes. Pass `{ repoBasename }` to scope to one repo
 * (same filter as listDevServerPids) so foreign-project vites do not inflate capacity.
 * @param {{ repoBasename?: string }} [opts]
 * @returns {number}
 */
function countLiveDevServers(opts) {
  return listDevServerPids(opts || {}).length;
}

module.exports = {
  parsePsLines,
  extractWorktreeHint,
  listDevServerPids,
  filterOrphans,
  listOrphanDevServers,
  killPids,
  countLiveDevServers,
};
