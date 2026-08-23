'use strict';

/**
 * Pure helpers for dispatch isolation (Task 3 edge-case mitigations).
 * Zero deps — path normalize only. Callers shell git / write JSON.
 *
 * A5 — dedupeRunning: one running record per taskId+pid
 * B1 — isMainCheckout / assertWorktreeNotMain: TOP==MAIN detector
 * B2 — pathsOutsideOwned: scope-drift note only (no auto-kill)
 */

const path = require('path');

/**
 * Normalize a filesystem path for equality checks.
 * Strips trailing slashes (except root), resolves `.`/`..`, no realpath (no I/O).
 */
function normalizePath(p) {
  if (p == null || p === '') return '';
  let n = path.resolve(String(p));
  // path.resolve already drops trailing slash except for root
  if (n.length > 1 && (n.endsWith('/') || n.endsWith(path.sep))) {
    n = n.slice(0, -1);
  }
  return n;
}

/**
 * True when toplevel checkout path is the same as the main repo path.
 * @param {string} toplevel
 * @param {string} mainPath
 */
function isMainCheckout(toplevel, mainPath) {
  const a = normalizePath(toplevel);
  const b = normalizePath(mainPath);
  if (!a || !b) return false;
  return a === b;
}

/**
 * Assert a worktree path is not the main checkout.
 * Returns a result object (no throw) so CLI can WARN non-fatally.
 * @param {string} wtPath
 * @param {string} mainPath
 * @returns {{ ok: boolean, reason?: string, toplevel?: string, mainPath?: string }}
 */
function assertWorktreeNotMain(wtPath, mainPath) {
  const toplevel = normalizePath(wtPath);
  const main = normalizePath(mainPath);
  if (!toplevel) {
    return { ok: false, reason: 'missing worktree path', toplevel, mainPath: main };
  }
  if (!main) {
    return { ok: false, reason: 'missing main path', toplevel, mainPath: main };
  }
  if (isMainCheckout(toplevel, main)) {
    return {
      ok: false,
      reason:
        'CRITICAL: worktree path resolves to MAIN checkout (TOP==MAIN). Builder may dirty product files on main.',
      toplevel,
      mainPath: main,
    };
  }
  return { ok: true, toplevel, mainPath: main };
}

/**
 * Finite positive pid usable as a dedupe key.
 * @param {*} pid
 */
function finitePid(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Dedupe key for running records: taskId + pid.
 * Returns null if record should not participate in running dedupe.
 * @param {object} rec
 */
function runningDedupeKey(rec) {
  if (!rec || rec.status !== 'running') return null;
  const pid = finitePid(rec.pid);
  if (pid == null) return null;
  const taskId = rec.taskId != null ? String(rec.taskId) : '';
  if (!taskId) return null;
  return taskId + '\0' + pid;
}

/**
 * Keep one running record per taskId+pid; drop later duplicates.
 * Prefer earliest createdAt (stable original run id for pause/resume).
 * Non-running records and records without finite pid are always kept.
 *
 * @param {Array<object>} list
 * @returns {{ kept: object[], dropped: object[] }}
 */
function dedupeRunning(list) {
  const records = Array.isArray(list) ? list.slice() : [];
  const kept = [];
  const dropped = [];
  /** @type {Map<string, object>} */
  const firstByKey = new Map();

  // First pass: among running+pid, pick survivor (earliest createdAt, then first seen)
  for (const rec of records) {
    const key = runningDedupeKey(rec);
    if (key == null) continue;
    const prev = firstByKey.get(key);
    if (!prev) {
      firstByKey.set(key, rec);
      continue;
    }
    const prevT = Number(prev.createdAt) || 0;
    const curT = Number(rec.createdAt) || 0;
    // Prefer earlier createdAt; if equal/missing, keep first seen (prev)
    if (curT > 0 && (prevT === 0 || curT < prevT)) {
      firstByKey.set(key, rec);
    }
  }

  const survivorIds = new Set();
  for (const rec of firstByKey.values()) {
    if (rec && rec.id != null) survivorIds.add(rec.id);
  }

  for (const rec of records) {
    const key = runningDedupeKey(rec);
    if (key == null) {
      kept.push(rec);
      continue;
    }
    const survivor = firstByKey.get(key);
    if (survivor && rec.id === survivor.id) {
      kept.push(rec);
    } else if (survivor && rec.id != null && survivor.id != null && rec.id !== survivor.id) {
      dropped.push(rec);
    } else if (survivor === rec) {
      // Same object reference without id
      kept.push(rec);
    } else {
      // Same key, different object, no stable id — drop non-survivor
      dropped.push(rec);
    }
  }

  return { kept, dropped };
}

/**
 * Find an existing running dispatch with the same taskId+pid (A5 online path).
 * Prefer earliest createdAt when multiple exist.
 * @param {Array<object>} list
 * @param {string} taskId
 * @param {number|string} pid
 * @returns {object|null}
 */
function findRunningDuplicate(list, taskId, pid) {
  const nPid = finitePid(pid);
  const t = taskId != null ? String(taskId) : '';
  if (nPid == null || !t) return null;
  let best = null;
  for (const rec of Array.isArray(list) ? list : []) {
    if (!rec || rec.status !== 'running') continue;
    if (String(rec.taskId || '') !== t) continue;
    if (finitePid(rec.pid) !== nPid) continue;
    if (!best) {
      best = rec;
      continue;
    }
    const bestT = Number(best.createdAt) || 0;
    const curT = Number(rec.createdAt) || 0;
    if (curT > 0 && (bestT === 0 || curT < bestT)) best = rec;
  }
  return best;
}

/**
 * B2: paths not covered by owned file prefixes (simple prefix / exact match).
 * No globs beyond trailing `/**` strip; no auto-kill — note-only helper.
 *
 * @param {string[]} changedPaths
 * @param {string[]} ownedFiles
 * @returns {string[]} paths outside owned set
 */
function pathsOutsideOwned(changedPaths, ownedFiles) {
  const changed = Array.isArray(changedPaths) ? changedPaths : [];
  const owned = Array.isArray(ownedFiles) ? ownedFiles : [];
  if (owned.length === 0) return changed.slice();

  const prefixes = owned.map((o) => {
    let s = String(o || '').replace(/\\/g, '/').trim();
    // Treat trailing /** or /* as directory prefix
    s = s.replace(/\/\*\*$/, '/').replace(/\/\*$/, '/');
    return s;
  }).filter(Boolean);

  return changed.filter((p) => {
    const rel = String(p || '').replace(/\\/g, '/');
    if (!rel) return false;
    for (const pref of prefixes) {
      if (rel === pref || rel === pref.replace(/\/$/, '')) return false;
      if (pref.endsWith('/')) {
        if (rel.startsWith(pref) || rel.startsWith(pref.slice(0, -1) + '/')) return false;
      } else if (rel.startsWith(pref + '/')) {
        return false;
      }
    }
    return true;
  });
}

/**
 * B2 convenience: scope-drift summary (note only).
 * @param {string[]} changedPaths
 * @param {string[]} ownedFiles
 * @returns {{ ok: boolean, outside: string[], note?: string }}
 */
function detectScopeDrift(changedPaths, ownedFiles) {
  const outside = pathsOutsideOwned(changedPaths, ownedFiles);
  if (outside.length === 0) return { ok: true, outside: [] };
  return {
    ok: false,
    outside,
    note: 'scope-drift: ' + outside.length + ' path(s) outside owned files: ' + outside.slice(0, 8).join(', '),
  };
}

module.exports = {
  normalizePath,
  isMainCheckout,
  assertWorktreeNotMain,
  dedupeRunning,
  findRunningDuplicate,
  pathsOutsideOwned,
  detectScopeDrift,
  finitePid,
  runningDedupeKey,
};
