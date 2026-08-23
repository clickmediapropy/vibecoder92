/**
 * Double-check merge/mark gate (edges F1/F2).
 * Refuse mark-done / integrate merge without `Double-check result: complete`
 * for each done board task. Zero third-party deps.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** Complete only — incomplete / partially complete must not match. */
const COMPLETE_RE = /Double-check result:\s*complete\b/i;

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function fileHasComplete(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  try {
    return COMPLETE_RE.test(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Candidate report paths for a task (worktree → MAIN → per-swarm).
 * @param {string} repo - MAIN repo path
 * @param {string} taskId
 * @param {{ worktree?: string, worktreePath?: string, swarmId?: string, extraDirs?: string[] }} [opts]
 * @returns {string[]}
 */
function doubleCheckReportPaths(repo, taskId, opts) {
  const o = opts || {};
  const id = String(taskId || '');
  const candidates = [];
  const wt = o.worktree || o.worktreePath;
  if (wt) {
    candidates.push(path.join(wt, '.grok-swarm', 'double-check', id + '.md'));
  }
  if (repo) {
    candidates.push(path.join(repo, '.grok-swarm', 'double-check', id + '.md'));
    if (o.swarmId) {
      candidates.push(
        path.join(repo, '.grok-swarm', 'swarms', String(o.swarmId), 'double-check', id + '.md'),
      );
    }
  }
  for (const d of o.extraDirs || []) {
    if (d) candidates.push(path.join(d, id + '.md'));
  }
  return candidates;
}

/**
 * Whether a task has a complete double-check report on an allowed path.
 * @param {string} repo
 * @param {string} taskId
 * @param {{ worktree?: string, worktreePath?: string, swarmId?: string, extraDirs?: string[] }} [opts]
 * @returns {{ ok: boolean, path?: string, reason?: string }}
 */
function doubleCheckComplete(repo, taskId, opts) {
  if (!taskId) return { ok: false, reason: 'missing taskId' };
  const candidates = doubleCheckReportPaths(repo, taskId, opts);
  for (const p of candidates) {
    if (fileHasComplete(p)) return { ok: true, path: p };
  }
  return {
    ok: false,
    reason:
      'double-check incomplete or missing for task ' +
      String(taskId) +
      ' (need file with "Double-check result: complete")',
  };
}

/**
 * All given task IDs must have complete DC reports.
 * @returns {{ ok: boolean, missing: string[], reason?: string }}
 */
function assertDoubleCheckTasks(repo, taskIds, opts) {
  const missing = [];
  for (const id of taskIds || []) {
    const r = doubleCheckComplete(repo, id, opts);
    if (!r.ok) missing.push(String(id));
  }
  if (missing.length) {
    return {
      ok: false,
      missing,
      reason:
        'double-check gate: missing complete reports for: ' +
        missing.join(', ') +
        ' (edge F1/F2)',
    };
  }
  return { ok: true, missing: [] };
}

/**
 * Board-level: every status=done task must have DC complete.
 * Empty board / no done tasks → not ok (fail closed).
 * @returns {{ ok: boolean, missing: string[], reason?: string }}
 */
function assertDoubleCheckBoard(repo, board, opts) {
  if (!board || !Array.isArray(board.tasks) || !board.tasks.length) {
    return { ok: false, missing: [], reason: 'double-check gate: empty board' };
  }
  const doneIds = board.tasks
    .filter((t) => t && t.status === 'done')
    .map((t) => t.id)
    .filter(Boolean);
  if (!doneIds.length) {
    return { ok: false, missing: [], reason: 'double-check gate: no done tasks' };
  }
  return assertDoubleCheckTasks(repo, doneIds, opts);
}

/**
 * Boolean board helper for mega-runtime C5 / exports.
 * registryRoot is typically <repo>/.grok-swarm.
 * @returns {boolean}
 */
function doubleCheckCompleteForBoard(registryRoot, board, swarmId) {
  if (!board || !Array.isArray(board.tasks) || !board.tasks.length) return false;
  const repo = registryRoot ? path.dirname(registryRoot) : null;
  const extraDirs = [];
  if (registryRoot) {
    extraDirs.push(path.join(registryRoot, 'double-check'));
    if (swarmId) {
      extraDirs.push(path.join(registryRoot, 'swarms', String(swarmId), 'double-check'));
    }
  }
  const r = assertDoubleCheckBoard(repo, board, { swarmId, extraDirs });
  return r.ok === true;
}

module.exports = {
  COMPLETE_RE,
  fileHasComplete,
  doubleCheckReportPaths,
  doubleCheckComplete,
  assertDoubleCheckTasks,
  assertDoubleCheckBoard,
  doubleCheckCompleteForBoard,
};
