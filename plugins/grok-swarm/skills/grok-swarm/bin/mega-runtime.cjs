/**
 * Mega-swarm runtime (P2–P4): daemon, visual gate, integrate merge, partition propose, floor mode.
 * Zero third-party deps. Required by mega.cjs.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');
const {
  resolveVisualTier,
  shouldRequireReviewResult,
  isForcePassEligible,
  DEFAULT_MAX_VISUAL_AGE_MS,
  VISUAL_TIERS,
} = require('./visual-policy.cjs');
const capacityApi = require('./capacity.cjs');
const dcGate = require('./double-check-gate.cjs');

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

function appendLog(logFile, line) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, '[' + new Date().toISOString() + '] ' + line + '\n', 'utf8');
  } catch { /* ignore */ }
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

function megaDir(registryRoot, megaId) {
  return path.join(registryRoot, 'mega', megaId);
}

function reviewArtifactsDir(registryRoot, swarmId) {
  return path.join(registryRoot, 'swarms', swarmId, 'review-artifacts');
}

/**
 * Hard visual gate: when visual_review is required, review_result.json must be PASS.
 * @returns {{ ok: boolean, reason?: string, result?: object }}
 */
function checkVisualGate(registryRoot, swarmId, { required = true } = {}) {
  if (!required) return { ok: true, skipped: true };
  const dir = reviewArtifactsDir(registryRoot, swarmId);
  const file = path.join(dir, 'review_result.json');
  if (!fs.existsSync(file)) {
    return {
      ok: false,
      reason: 'visual gate: missing ' + file + ' (agent-browser reviewer must write PASS)',
    };
  }
  const result = readJsonSafe(file, null);
  if (!result || typeof result !== 'object') {
    return { ok: false, reason: 'visual gate: invalid review_result.json' };
  }
  const status = String(result.status || '').toUpperCase();
  if (status !== 'PASS') {
    return {
      ok: false,
      reason: 'visual gate: status=' + (result.status || '?') + ' (need PASS)',
      result,
    };
  }
  return { ok: true, result };
}

/**
 * Write a PASS stub for tests / non-UI with --force-visual-pass (not for production use lightly).
 */
function writeVisualPass(registryRoot, swarmId, summary) {
  const dir = reviewArtifactsDir(registryRoot, swarmId);
  writeJsonPretty(path.join(dir, 'review_result.json'), {
    status: 'PASS',
    summary: summary || 'forced or automated PASS',
    findings: [],
    routesChecked: [],
  });
}

/**
 * Queue wait reason for status/watch (E1): capacity vs depends_on.
 * @returns {'capacity'|'depends_on'|null}
 */
function queuedReason(sub, statusMap) {
  const s = sub || {};
  const name = s.name;
  const status = (name && statusMap && statusMap[name]) || s.status;
  if (status !== 'queued' && status !== 'planned') return null;
  const deps = Array.isArray(s.depends_on) ? s.depends_on : [];
  const map = statusMap || {};
  const depsOk = deps.every((d) => map[d] === 'done' || map[d] === 'cancelled');
  if (!depsOk) return 'depends_on';
  return 'capacity';
}

/**
 * Visual stall age for C5 age-pass. Prefer first visual-wait stamp, else sub startedAt.
 * Injectable `now` for tests.
 */
function visualAgeMsForSub(sub, opts) {
  const o = opts || {};
  const now = o.now != null ? Number(o.now) : Date.now();
  const s = sub || {};
  const since = Number(s.visualWaitSince || s.startedAt || s.updatedAt || 0);
  if (!since || !Number.isFinite(since)) return 0;
  return Math.max(0, now - since);
}

/**
 * Double-check reports complete for all done board tasks (F1/F2).
 * Delegates to double-check-gate.cjs (single source of truth).
 */
function doubleCheckCompleteForBoard(registryRoot, board, swarmId) {
  return dcGate.doubleCheckCompleteForBoard(registryRoot, board, swarmId);
}

/**
 * Infer code gates green for age-pass when board is terminal (no building).
 * Conservative: only when every task is done/cancelled.
 */
function inferCodeGatesGreenFromBoard(board) {
  if (!board || !Array.isArray(board.tasks) || !board.tasks.length) return false;
  return board.tasks.every((t) => t.status === 'done' || t.status === 'cancelled');
}

/**
 * C5: missing review_result (or non-PASS), aged past max, gates+DC green → writeVisualPass.
 * Uses synthetic BLOCKED so isForcePassEligible remains single policy source.
 * @returns {{ passed: boolean, reason?: string, ageMs?: number }}
 */
function maybeAgeVisualPass(registryRoot, swarmId, sub, board, opts) {
  const o = opts || {};
  const now = o.now != null ? Number(o.now) : Date.now();
  const maxAge =
    o.maxVisualAgeMs != null ? Number(o.maxVisualAgeMs) : DEFAULT_MAX_VISUAL_AGE_MS;
  const ageMs = visualAgeMsForSub(sub, { now });
  if (ageMs < maxAge) {
    return { passed: false, reason: 'under age threshold', ageMs, maxAge };
  }
  const codeGatesGreen =
    o.codeGatesGreen === true ||
    (o.codeGatesGreen !== false && inferCodeGatesGreenFromBoard(board));
  const doubleCheckComplete =
    o.doubleCheckComplete === true ||
    (o.doubleCheckComplete !== false &&
      doubleCheckCompleteForBoard(registryRoot, board, swarmId));
  // Synthetic BLOCKED "no-result" — age + gates+DC unlocks force-pass per policy
  const synthetic = {
    status: 'BLOCKED',
    summary: 'no-result age — visual dispatch missing or timed out',
    findings: [{ severity: 'info', message: 'missing review_result.json' }],
    routesChecked: [],
  };
  const elig = isForcePassEligible({
    result: synthetic,
    codeGatesGreen,
    doubleCheckComplete,
    visualAgeMs: ageMs,
    maxVisualAgeMs: maxAge,
  });
  if (!elig.ok) {
    return { passed: false, reason: elig.reason, ageMs, maxAge };
  }
  if (o.dryRun) {
    return { passed: true, reason: elig.reason + ' (dry-run)', ageMs, maxAge, dryRun: true };
  }
  writeVisualPass(
    registryRoot,
    swarmId,
    'age-pass no review_result (' + elig.reason + '; ageMs=' + ageMs + ')',
  );
  return { passed: true, reason: elig.reason, ageMs, maxAge };
}

function swarmTaskState(ctx, registryRoot, swarmId) {
  try {
    const ws = ctx.buildWorkspace(registryRoot, swarmId);
    if (!fs.existsSync(ws.root)) return null;
    return ctx.readState(ws);
  } catch {
    return null;
  }
}

function allTasksTerminal(state) {
  if (!state || !state.tasks || !state.tasks.length) return false;
  return state.tasks.every((t) =>
    t.status === 'done' || t.status === 'cancelled' || t.status === 'blocked');
}

function allTasksDoneish(state) {
  if (!state || !state.tasks || !state.tasks.length) return false;
  return state.tasks.every((t) => t.status === 'done' || t.status === 'cancelled');
}

function anyBlocked(state) {
  return (state && state.tasks || []).some((t) => t.status === 'blocked');
}

function readCoordinatorPid(registryRoot, swarmId) {
  const sid = swarmId || 'default';
  const perSwarm = path.join(registryRoot, 'swarms', sid, 'coordinator.pid');
  const legacy = path.join(registryRoot, 'coordinator.pid');
  for (const file of [perSwarm, sid === 'default' ? legacy : null].filter(Boolean)) {
    const rec = readJsonSafe(file, null);
    if (!rec || !rec.pid) continue;
    if (isAlive(rec.pid)) return rec;
  }
  return null;
}

/**
 * D4: re-check peer mega file leases; block this mega's offending subs (do not kill peer).
 * @returns {object[]} actions
 */
function recheckPeerLeases(registryRoot, plan, state, megaId) {
  const actions = [];
  let cross = [];
  try {
    cross = capacityApi.findCrossMegaLeaseConflicts(registryRoot, plan, {
      excludeMegaId: megaId,
    }) || [];
  } catch {
    return actions;
  }
  if (!cross.length) return actions;

  const clashing = new Set();
  const reasons = new Map();
  for (const c of cross) {
    const mine = Array.isArray(c.subswarms) ? c.subswarms[0] : null;
    if (mine) {
      clashing.add(mine);
      if (!reasons.has(mine)) reasons.set(mine, c.message || 'peer lease clash');
    }
  }
  for (const name of clashing) {
    const sub = state.subswarms[name];
    if (!sub) continue;
    if (['done', 'cancelled', 'blocked', 'failed'].includes(sub.status)) continue;
    sub.status = 'blocked';
    sub.finishedAt = Date.now();
    const reason = reasons.get(name) || 'peer lease clash';
    sub.note = ((sub.note || '') + ' peer-lease-clash: ' + reason).trim();
    actions.push({
      type: 'peer-lease-clash',
      sub: name,
      edge: 'D4',
      reason,
    });
  }
  return actions;
}

/**
 * Reconcile one mega mission: mark done when board complete + visual gate; restart coordinator; return actions.
 */
function reconcileMega(ctx, repo, megaId, opts = {}) {
  const registryRoot = path.join(repo, '.grok-swarm');
  const dir = megaDir(registryRoot, megaId);
  const plan = readJsonSafe(path.join(dir, 'plan.json'), null);
  const state = readJsonSafe(path.join(dir, 'state.json'), null);
  if (!plan || !state) return { ok: false, error: 'missing plan/state' };

  const actions = [];
  const forceVisual = opts.forceVisualPass === true;
  const now = opts.now != null ? Number(opts.now) : Date.now();

  // D4 — peer lease recheck before processing / re-launch (force must not skip mid-flight)
  const leaseActs = recheckPeerLeases(registryRoot, plan, state, megaId);
  actions.push(...leaseActs);

  for (const name of Object.keys(state.subswarms || {})) {
    const sub = state.subswarms[name];
    if (sub.status !== 'running' && sub.status !== 'queued') continue;

    const swarmId = sub.swarmId;
    const planSub = (plan.subswarms || []).find((s) => s.name === name) || {};
    // Keep depends_on on state for queued_reason enrichment
    if (!sub.depends_on && planSub.depends_on) sub.depends_on = planSub.depends_on;
    if (!sub.name) sub.name = name;

    // Heal zombie dispatches (running + dead PID) before reading board/gates.
    // Mirrors swarm heal / dispatch reconcile so mega tick does not wait on ghosts.
    if (swarmId && ctx.reconcileDeadDispatches && ctx.buildWorkspace) {
      try {
        const ws = ctx.buildWorkspace(registryRoot, swarmId);
        const healed = ctx.reconcileDeadDispatches(ws) || [];
        for (const h of healed) {
          actions.push({
            type: 'dispatch-reconcile',
            sub: name,
            swarmId,
            id: h.id,
            to: h.to,
            reason: h.reason,
          });
        }
      } catch {
        /* ignore */
      }
    }

    const board = swarmTaskState(ctx, registryRoot, swarmId);

    // Floor mode: no Grok coordinator — meta dispatches builders
    if (sub.floor || planSub.floor) {
      const floorActs = runFloorTick(ctx, repo, megaId, name, sub, plan, opts);
      actions.push(...floorActs);
    }

    // Detect board completion
    if (board && allTasksDoneish(board) && !anyBlocked(board)) {
      // Prefer plan tier when state is missing visual_tier
      const tier = resolveVisualTier({ ...planSub, ...sub });
      sub.visual_tier = tier;
      const needsVisual = shouldRequireReviewResult(tier);

      // D5 — gates_only: skip visual gate; note once
      if (!needsVisual) {
        if (!sub.visualSkipped) {
          sub.visualSkipped = true;
          sub.note = ((sub.note || '') + ' visual skipped (gates_only)').trim();
          actions.push({
            type: 'visual-skipped',
            sub: name,
            tier,
            edge: 'D5',
          });
        }
      }

      if (needsVisual && forceVisual) {
        writeVisualPass(registryRoot, swarmId, 'meta force-visual-pass');
      }
      // gates_only: skip checkVisualGate (required: false)
      const gate = checkVisualGate(registryRoot, swarmId, { required: needsVisual });
      if (!gate.ok) {
        // C5 — stamp first wait; age-pass when eligible
        if (!sub.visualWaitSince) sub.visualWaitSince = now;
        const agePass = maybeAgeVisualPass(registryRoot, swarmId, sub, board, {
          now,
          maxVisualAgeMs: opts.maxVisualAgeMs,
          codeGatesGreen: opts.codeGatesGreen,
          doubleCheckComplete: opts.doubleCheckComplete,
          dryRun: opts.dryRun === true,
        });
        if (agePass.passed && !agePass.dryRun) {
          sub.note = ((sub.note || '') + ' age-pass no review_result').trim();
          actions.push({
            type: 'visual-age-pass',
            sub: name,
            edge: 'C5',
            reason: agePass.reason,
            ageMs: agePass.ageMs,
          });
          // re-check gate after write
          const gate2 = checkVisualGate(registryRoot, swarmId, { required: true });
          if (!gate2.ok) {
            actions.push({ type: 'visual-wait', sub: name, reason: gate2.reason });
            continue;
          }
        } else if (agePass.passed && agePass.dryRun) {
          actions.push({
            type: 'visual-age-pass',
            sub: name,
            edge: 'C5',
            reason: agePass.reason,
            dryRun: true,
          });
          continue;
        } else {
          actions.push({
            type: 'visual-wait',
            sub: name,
            reason: gate.reason,
            ageMs: agePass.ageMs,
            agePassReason: agePass.reason,
          });
          continue;
        }
      }

      // F2 — refuse mark-done without double-check complete (opts.skipDoubleCheck / force for tests only)
      if (opts.skipDoubleCheck !== true && opts.force !== true) {
        const dc = dcGate.assertDoubleCheckBoard(repo, board, { swarmId });
        if (!dc.ok) {
          actions.push({
            type: 'double-check-wait',
            sub: name,
            edge: 'F2',
            reason: dc.reason,
            missing: dc.missing,
          });
          continue;
        }
      }

      sub.status = 'done';
      sub.finishedAt = now;
      sub.note = ((sub.note || '') + ' reconciled done').trim();
      sub.queued_reason = null;
      actions.push({ type: 'mark-done', sub: name });
    } else if (board && anyBlocked(board)) {
      sub.status = 'blocked';
      sub.finishedAt = now;
      actions.push({ type: 'mark-blocked', sub: name });
    } else if (sub.status === 'running' && !sub.floor) {
      // coordinator health (per-swarm pidfile)
      const coord = readCoordinatorPid(registryRoot, swarmId);
      if (!coord || !coord.pid) {
        actions.push({ type: 'coordinator-missing', sub: name, swarmId });
        if (opts.restartCoordinator !== false) {
          try {
            ctx.launchCommand([
              repo,
              '--swarm', swarmId,
              '--no-dashboard',
            ]);
            actions.push({ type: 'coordinator-started', sub: name, swarmId });
          } catch (err) {
            actions.push({ type: 'coordinator-start-failed', sub: name, error: String(err.message || err) });
          }
        }
      } else if (!isAlive(coord.pid)) {
        actions.push({ type: 'coordinator-dead', sub: name, swarmId, pid: coord.pid });
        if (opts.restartCoordinator !== false) {
          try {
            ctx.launchCommand([
              repo,
              '--swarm', swarmId,
              '--no-dashboard',
              '--resume',
            ]);
            actions.push({ type: 'coordinator-restarted', sub: name, swarmId });
          } catch (err) {
            actions.push({ type: 'coordinator-restart-failed', sub: name, error: String(err.message || err) });
          }
        }
      }
    }
  }

  // E1 — enrich queued_reason on every reconcile for status/watch
  const statusMap = {};
  for (const [n, s] of Object.entries(state.subswarms)) statusMap[n] = s.status;
  for (const [n, s] of Object.entries(state.subswarms)) {
    const planSub = (plan.subswarms || []).find((x) => x.name === n) || {};
    const reason = queuedReason(
      { name: n, status: s.status, depends_on: s.depends_on || planSub.depends_on },
      statusMap,
    );
    if (reason) s.queued_reason = reason;
    else if (s.queued_reason) delete s.queued_reason;
  }
  const allDone = Object.values(state.subswarms).every((s) =>
    s.status === 'done' || s.status === 'cancelled');
  // Packs done ≠ mega complete. Preserve merge_blocked / integrated / merged.
  // Only set completed when packs finish and we are not mid-integrate failure (B3).
  if (allDone) {
    const sticky = new Set(['merge_blocked', 'integrated', 'merged']);
    if (!sticky.has(state.status)) {
      state.status = 'completed'; // packs done; auto-merge may still run
    }
  }
  state.updatedAt = now;
  if (opts.dryRun !== true) {
    writeJsonPretty(path.join(dir, 'state.json'), state);
  }

  return { ok: true, actions, state, plan, statusMap, allDone };
}

/**
 * Minimal floor manager: for floor-mode subswarms, if task is ready and no running dispatch, spawn one builder via dispatch-grok.
 */
function runFloorTick(ctx, repo, megaId, subName, sub, plan, opts) {
  const actions = [];
  const registryRoot = path.join(repo, '.grok-swarm');
  const swarmId = sub.swarmId;
  const skillRoot = ctx.skillRootDir();
  const swarmBin = path.join(skillRoot, 'bin', 'swarm.cjs');
  const dispatchSh = path.join(skillRoot, 'bin', 'dispatch-grok.sh');

  let ready;
  try {
    const out = execFileSync(
      process.execPath,
      [swarmBin, '--swarm', swarmId, 'task', 'ready', '--json'],
      {
        cwd: repo,
        env: { ...process.env, SWARM_AGENT_NAME: 'Coordinator', SWARM_ID: swarmId },
        encoding: 'utf8',
      },
    );
    ready = JSON.parse(out);
  } catch {
    return actions;
  }
  const tasks = Array.isArray(ready) ? ready : (ready.tasks || ready);
  if (!tasks || !tasks.length) return actions;

  // any running dispatch?
  try {
    const ws = ctx.buildWorkspace(registryRoot, swarmId);
    const dispDir = ws.dispatches || ws.dispatchesDir;
    if (dispDir && fs.existsSync(dispDir)) {
      for (const f of fs.readdirSync(dispDir).filter((x) => x.endsWith('.json'))) {
        const rec = readJsonSafe(path.join(dispDir, f), {});
        if (rec.status === 'running' && isAlive(rec.pid)) {
          actions.push({ type: 'floor-busy', sub: subName });
          return actions;
        }
      }
    }
  } catch { /* ignore */ }

  const task = tasks[0];
  const promptPath = path.join(registryRoot, 'swarms', swarmId, 'floor-prompt-' + task.id + '.md');
  const files = (task.ownedFiles || sub.files || []).join('\n- ');
  const body = [
    'You are a FLOOR builder in grok-swarm (no separate coordinator LLM).',
    'Repo MAIN: ' + repo,
    'Swarm: ' + swarmId,
    'Task: ' + task.id + ' — ' + (task.title || ''),
    'Owned files only:',
    '- ' + files,
    '',
    'Acceptance: ' + (task.acceptance || plan.subswarms.find((s) => s.name === subName)?.acceptance || 'gates green'),
    '',
    'Work only in the isolated worktree. Commit on your branch. Report done via swarm task update.',
    'Never edit files outside owned set. Never commit .env.local.',
  ].join('\n');
  fs.mkdirSync(path.dirname(promptPath), { recursive: true });
  fs.writeFileSync(promptPath, body, 'utf8');

  if (opts.dryRun) {
    actions.push({ type: 'floor-would-dispatch', sub: subName, task: task.id });
    return actions;
  }

  const wtName = 'wt-floor-' + megaId + '-' + subName + '-' + String(task.id).slice(-8);
  const logFile = path.join(registryRoot, 'swarms', swarmId, 'floor-' + task.id + '.log');
  let base;
  try {
    base = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    base = 'HEAD';
  }

  try {
    const child = spawn(
      'bash',
      [
        dispatchSh,
        '--mode', 'new',
        '--repo', repo,
        '--worktree', wtName,
        '--base', base,
        '--agent', 'Builder 1',
        '--prompt-file', promptPath,
        '--log', logFile,
      ],
      {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, SWARM_AGENT_NAME: 'Builder 1', SWARM_ID: swarmId },
      },
    );
    child.unref();
    // record dispatch
    try {
      execFileSync(
        process.execPath,
        [
          swarmBin, '--swarm', swarmId, 'dispatch', 'record',
          '--task', task.id,
          '--agent', 'Builder 1',
          '--worktree', wtName,
          '--log', logFile,
          '--pid', String(child.pid),
          '--base', base,
        ],
        {
          cwd: repo,
          env: { ...process.env, SWARM_AGENT_NAME: 'Coordinator', SWARM_ID: swarmId },
          encoding: 'utf8',
        },
      );
    } catch { /* ignore */ }
    try {
      execFileSync(
        process.execPath,
        [swarmBin, '--swarm', swarmId, 'task', 'update', '--id', task.id, '--status', 'building', '--note', 'floor dispatch'],
        {
          cwd: repo,
          env: { ...process.env, SWARM_AGENT_NAME: 'Coordinator', SWARM_ID: swarmId },
          encoding: 'utf8',
        },
      );
    } catch { /* ignore */ }
    actions.push({ type: 'floor-dispatch', sub: subName, task: task.id, pid: child.pid, worktree: wtName });
  } catch (err) {
    actions.push({ type: 'floor-dispatch-failed', sub: subName, error: String(err.message || err) });
  }
  return actions;
}

/**
 * Paths where both sides of a conflict are almost always append-only indexes /
 * learnings. Safe to retry with `git merge -X union` (B3 auto path).
 * Matches `docs/solutions/INDEX.md` and local `.grok-swarm/learnings/**`.
 */
const UNION_MERGE_SAFE_PATTERNS = [
  /(^|\/)docs\/solutions\/INDEX\.md$/i,
  /(^|\/)docs\/solutions\/.*\/INDEX\.md$/i,
  /(^|\/)\.grok-swarm\/learnings\//i,
  /(^|\/)docs\/learnings\//i,
  /(^|\/)SUMMARY\.md$/i,
];

function isUnionMergeSafePath(filePath) {
  const p = String(filePath || '').replace(/\\/g, '/');
  return UNION_MERGE_SAFE_PATTERNS.some((re) => re.test(p));
}

function listUnmergedPaths(repo) {
  try {
    const out = execFileSync(
      'git',
      ['-C', repo, 'diff', '--name-only', '--diff-filter=U'],
      { encoding: 'utf8' },
    );
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isAncestorOfHead(repo, branch) {
  const r = spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', branch, 'HEAD'], {
    encoding: 'utf8',
  });
  return r.status === 0;
}

function tryAbortMerge(repo) {
  try {
    execFileSync('git', ['-C', repo, 'merge', '--abort'], { encoding: 'utf8' });
  } catch { /* ignore */ }
}

/**
 * Write merge-conflict artifact + prompt for a builder redispatch.
 * Never resolves conflicts in-process (coordinator rule).
 */
function writeMergeConflictArtifact(dir, payload) {
  const file = path.join(dir, 'merge-conflict.json');
  writeJsonPretty(file, payload);
  const promptPath = path.join(dir, 'merge-conflict-resolve.md');
  const files = (payload.conflicts || []).join(', ') || '(see git status)';
  const body = [
    '# Mega integrate merge conflict — resolve as Builder',
    '',
    'You are a **Builder** (not coordinator). Resolve the git merge conflict so',
    'the mega integrate branch can finish. Do **not** invent product features.',
    '',
    '## Context',
    '',
    '- Mega id: `' + (payload.megaId || '') + '`',
    '- Integrate branch: `' + (payload.integrate || '') + '`',
    '- Failed sub-branch: `' + (payload.branch || '') + '` (sub: `' + (payload.sub || '') + '`)',
    '- Conflicted files: ' + files,
    '',
    '## Required steps',
    '',
    '1. `git checkout ' + (payload.integrate || 'integrate') + '`',
    '2. `git merge --no-ff ' + (payload.branch || '<branch>') +
      ' -m "swarm: mega ' + (payload.megaId || '') + ' merge sub ' + (payload.sub || '') + '"`',
    '3. Resolve **every** conflict preserving **both** sides\' intent:',
    '   - For `docs/solutions/INDEX.md` / learnings indexes: keep **all** unique lines (union).',
    '   - For product code: prefer the sub-branch change when it is the owned pack;',
    '     otherwise keep both behaviors if compatible.',
    '4. `git add` resolved files; complete the merge commit if not already committed.',
    '5. Run the repo\'s usual gates if available (`npm run typecheck` or project equivalent).',
    '6. Exit when `git status` is clean on the integrate branch and the failed sub is an ancestor of HEAD.',
    '',
    '## Hard rules',
    '',
    '- Work only on the integrate merge; do not push; do not rewrite unrelated history.',
    '- Do not edit files outside conflict resolution + required gates.',
    '',
  ].join('\n');
  try {
    fs.writeFileSync(promptPath, body, 'utf8');
  } catch { /* ignore */ }
  return { artifact: file, promptPath };
}

/**
 * Best-effort: spawn a builder to resolve integrate conflict (Mode B / new wt).
 * Tests and offline hosts skip when dispatch-grok.sh or grok is missing.
 */
function dispatchMergeConflictResolver(ctx, repo, megaId, conflictMeta, opts = {}) {
  if (opts.dispatchResolver === false) {
    return { dispatched: false, reason: 'dispatchResolver=false' };
  }
  const skillRoot = ctx && typeof ctx.skillRootDir === 'function' ? ctx.skillRootDir() : null;
  const dispatchSh = skillRoot ? path.join(skillRoot, 'bin', 'dispatch-grok.sh') : null;
  if (!dispatchSh || !fs.existsSync(dispatchSh)) {
    return { dispatched: false, reason: 'dispatch-grok.sh missing' };
  }
  const dir = megaDir(path.join(repo, '.grok-swarm'), megaId);
  const promptPath = path.join(dir, 'merge-conflict-resolve.md');
  if (!fs.existsSync(promptPath)) {
    return { dispatched: false, reason: 'prompt missing' };
  }
  // Rate-limit: one active resolver per mega
  const stampFile = path.join(dir, 'merge-conflict-dispatch.json');
  const prev = readJsonSafe(stampFile, null);
  if (prev && prev.pid && isAlive(prev.pid) && Date.now() - (prev.at || 0) < 30 * 60 * 1000) {
    return { dispatched: false, reason: 'resolver already running', pid: prev.pid };
  }
  const attempts = (prev && prev.attempts) || 0;
  if (attempts >= 3) {
    return { dispatched: false, reason: 'max resolver attempts (3)' };
  }
  const wtName = 'wt-mega-merge-' + String(megaId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  const logPath = path.join(dir, 'merge-conflict-resolver.log');
  try {
    const out = execFileSync(
      'bash',
      [
        dispatchSh,
        '--mode', 'new',
        '--repo', repo,
        '--worktree', wtName,
        '--base', conflictMeta.integrate || 'HEAD',
        '--agent', 'Builder MergeResolve',
        '--prompt-file', promptPath,
        '--log', logPath,
      ],
      {
        cwd: repo,
        env: { ...process.env, SWARM_AGENT_NAME: 'Builder MergeResolve' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120000,
      },
    );
    const pidMatch = String(out).match(/PID=(\d+)/);
    const pid = pidMatch ? Number(pidMatch[1]) : null;
    writeJsonPretty(stampFile, {
      at: Date.now(),
      attempts: attempts + 1,
      pid,
      worktree: wtName,
      log: logPath,
      branch: conflictMeta.branch,
      sub: conflictMeta.sub,
    });
    return { dispatched: true, pid, worktree: wtName, log: logPath, out: String(out).slice(0, 500) };
  } catch (err) {
    writeJsonPretty(stampFile, {
      at: Date.now(),
      attempts: attempts + 1,
      error: String(err.stderr || err.message || err).slice(0, 800),
      branch: conflictMeta.branch,
      sub: conflictMeta.sub,
    });
    return {
      dispatched: false,
      reason: 'dispatch failed: ' + String(err.stderr || err.message || err).slice(0, 400),
    };
  }
}

/**
 * Resolve unmerged paths with `git merge-file --union` (append both sides).
 * Leaves the merge in progress; caller must `git commit` after all paths are staged.
 * @returns {{ ok: boolean, error?: string }}
 */
function resolveConflictsWithUnion(repo, conflicts) {
  const tmpRoot = fs.mkdtempSync(path.join(repo, '.git', 'swarm-union-'));
  try {
    for (const file of conflicts) {
      const baseF = path.join(tmpRoot, 'base');
      const oursF = path.join(tmpRoot, 'ours');
      const theirsF = path.join(tmpRoot, 'theirs');
      let hasBase = true;
      try {
        const base = execFileSync('git', ['-C', repo, 'show', ':1:' + file], { encoding: 'utf8' });
        fs.writeFileSync(baseF, base);
      } catch {
        hasBase = false;
        fs.writeFileSync(baseF, '');
      }
      try {
        fs.writeFileSync(
          oursF,
          execFileSync('git', ['-C', repo, 'show', ':2:' + file], { encoding: 'utf8' }),
        );
      } catch (err) {
        return { ok: false, error: 'missing ours stage for ' + file + ': ' + err.message };
      }
      try {
        fs.writeFileSync(
          theirsF,
          execFileSync('git', ['-C', repo, 'show', ':3:' + file], { encoding: 'utf8' }),
        );
      } catch (err) {
        return { ok: false, error: 'missing theirs stage for ' + file + ': ' + err.message };
      }
      // merge-file --union: result written into oursF; exit 0 even with "conflicts" resolved
      try {
        execFileSync(
          'git',
          ['merge-file', '--union', oursF, baseF, theirsF],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        );
      } catch (err) {
        // merge-file returns non-zero when markers remain; with --union should be rare
        if (!fs.existsSync(oursF)) {
          return {
            ok: false,
            error: 'merge-file --union failed for ' + file + ': ' + (err.message || err),
          };
        }
      }
      const dest = path.join(repo, file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(oursF, dest);
      execFileSync('git', ['-C', repo, 'add', '--', file], { encoding: 'utf8' });
      void hasBase;
    }
    return { ok: true };
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}

/**
 * Merge one branch into current HEAD (integrate). On conflict:
 * 1. If all unmerged paths are union-safe → git merge-file --union + commit
 * 2. Else abort, record conflict, leave for builder redispatch
 *
 * Note: modern git default strategy is `ort`, which has no `-X union`. We resolve
 * in-tree with merge-file instead of relying on strategy options.
 *
 * @returns {{ ok: boolean, strategy?: string, conflicts?: string[], error?: string, unionRetried?: boolean }}
 */
function mergeOneBranch(repo, branch, message, opts = {}) {
  if (isAncestorOfHead(repo, branch)) {
    return { ok: true, strategy: 'already-merged' };
  }
  try {
    execFileSync(
      'git',
      ['-C', repo, 'merge', '--no-ff', branch, '-m', message],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { ok: true, strategy: 'merge' };
  } catch (err) {
    const conflicts = listUnmergedPaths(repo);
    const allUnionSafe =
      conflicts.length > 0 && conflicts.every((f) => isUnionMergeSafePath(f));
    if (allUnionSafe && opts.allowUnion !== false) {
      const resolved = resolveConflictsWithUnion(repo, conflicts);
      if (resolved.ok) {
        // Finish the in-progress merge with the unioned files
        try {
          execFileSync(
            'git',
            ['-C', repo, 'commit', '--no-edit', '-m', message + ' (union)'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
          );
          return { ok: true, strategy: 'union', unionRetried: true, conflicts };
        } catch (err2) {
          tryAbortMerge(repo);
          return {
            ok: false,
            strategy: 'union-failed',
            unionRetried: true,
            conflicts,
            error: 'commit after union: ' + String(err2.stderr || err2.message || err2).slice(0, 400),
          };
        }
      }
      tryAbortMerge(repo);
      return {
        ok: false,
        strategy: 'union-failed',
        unionRetried: true,
        conflicts,
        error: resolved.error || 'union resolve failed',
      };
    }
    tryAbortMerge(repo);
    return {
      ok: false,
      strategy: 'conflict',
      conflicts,
      error: String(err.stderr || err.message || err).slice(0, 500),
    };
  }
}

/**
 * Merge done sub-swarm branches into integrate, optionally into default branch.
 *
 * Hardening (B3):
 * - Skip branches already ancestors of integrate (idempotent retry)
 * - Auto-retry with `-X union` when conflicts are only on learnings/INDEX paths
 * - On hard conflict: abort, write merge-conflict.json, set status merge_blocked,
 *   optionally dispatch a builder — never mark mega completed / never leave half-merge
 * - Mega run loop must NOT exit while status is merge_blocked
 */
function mergeIntegrate(repo, megaId, opts = {}) {
  const registryRoot = path.join(repo, '.grok-swarm');
  const dir = megaDir(registryRoot, megaId);
  const plan = readJsonSafe(path.join(dir, 'plan.json'), null);
  const state = readJsonSafe(path.join(dir, 'state.json'), null);
  if (!plan || !state) return { ok: false, error: 'missing plan/state' };

  const integrate = plan.integrate_branch || ('swarm/integrate/' + megaId);
  const defaultBranch = plan.default_branch || 'master';
  const report = {
    megaId,
    integrate,
    merged: [],
    skipped: [],
    errors: [],
    conflicts: [],
    unionRetried: [],
    toMain: false,
    needsResolve: false,
  };

  // Ensure integrate branch exists from base_ref or HEAD
  const base = plan.base_ref || 'HEAD';
  try {
    const has = spawnSync('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/' + integrate]);
    if (has.status !== 0) {
      execFileSync('git', ['-C', repo, 'branch', integrate, base], { encoding: 'utf8' });
    }
  } catch (err) {
    report.errors.push('create integrate: ' + (err.message || err));
    return { ok: false, ...report };
  }

  // Topo order: only merge subs that are done, deps done
  const order = [];
  const visited = new Set();
  function visit(name) {
    if (visited.has(name)) return;
    visited.add(name);
    const sub = state.subswarms[name];
    if (!sub) return;
    for (const d of sub.depends_on || []) visit(d);
    order.push(name);
  }
  for (const name of Object.keys(state.subswarms || {})) visit(name);

  // checkout integrate
  try {
    execFileSync('git', ['-C', repo, 'checkout', integrate], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    report.errors.push('checkout integrate: ' + (err.stderr || err.message || err));
    return { ok: false, ...report };
  }

  let hardConflict = null;

  for (const name of order) {
    const sub = state.subswarms[name];
    if (sub.status !== 'done' && sub.status !== 'cancelled') {
      report.skipped.push({ name, reason: 'status=' + sub.status });
      continue;
    }
    if (sub.status === 'cancelled') continue;

    // visual gate again (skip gates_only)
    const mergeNeedsVisual = shouldRequireReviewResult(resolveVisualTier(sub));
    if (mergeNeedsVisual && !opts.skipVisualGate) {
      const gate = checkVisualGate(registryRoot, sub.swarmId, { required: true });
      if (!gate.ok) {
        report.skipped.push({ name, reason: gate.reason });
        report.errors.push(name + ': ' + gate.reason);
        continue;
      }
    }

    // F1 — refuse integrate merge without double-check complete when board has done tasks.
    // skipDoubleCheck/force: tests only. If board unreadable → fail closed.
    // If board has no done tasks (e.g. sub force-marked without board terminal), DC is
    // enforced on the mark-done path (F2); do not block merge solely for empty done-set.
    if (opts.skipDoubleCheck !== true && opts.force !== true) {
      let board = null;
      if (opts.ctx && typeof opts.ctx.buildWorkspace === 'function') {
        board = swarmTaskState(opts.ctx, registryRoot, sub.swarmId);
      }
      if (!board) {
        const reason =
          'double-check gate: no board for ' + name + ' (edge F1 — fail closed)';
        report.skipped.push({ name, reason, edge: 'F1' });
        report.errors.push(name + ': ' + reason);
        continue;
      }
      const doneCount = (board.tasks || []).filter((t) => t && t.status === 'done').length;
      if (doneCount > 0) {
        const dc = dcGate.assertDoubleCheckBoard(repo, board, { swarmId: sub.swarmId });
        if (!dc.ok) {
          const reason = dc.reason || 'double-check incomplete (edge F1)';
          report.skipped.push({ name, reason, edge: 'F1', missing: dc.missing });
          report.errors.push(name + ': ' + reason);
          continue;
        }
      }
    }

    const branch = sub.branch || ('swarm/sub/' + megaId + '/' + name);
    const show = spawnSync('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/' + branch]);
    if (show.status !== 0) {
      report.skipped.push({ name, reason: 'branch missing: ' + branch });
      continue;
    }

    const msg = 'swarm: mega ' + megaId + ' merge sub ' + name;
    const result = mergeOneBranch(repo, branch, msg, { allowUnion: opts.allowUnion !== false });
    if (result.strategy === 'already-merged') {
      report.skipped.push({ name, reason: 'already-merged' });
      continue;
    }
    if (result.ok) {
      report.merged.push(branch);
      if (result.unionRetried) {
        report.unionRetried.push({ name, branch, files: result.conflicts || [] });
      }
      continue;
    }

    // Hard conflict — stop further merges (integrate left clean via abort)
    hardConflict = {
      megaId,
      integrate,
      sub: name,
      branch,
      conflicts: result.conflicts || [],
      strategy: result.strategy,
      error: result.error,
      unionRetried: !!result.unionRetried,
      at: Date.now(),
    };
    report.needsResolve = true;
    report.conflicts.push(hardConflict);
    report.errors.push(
      'merge ' + branch + ': conflict in ' +
        ((result.conflicts && result.conflicts.length)
          ? result.conflicts.join(', ')
          : '(unknown)') +
        (result.error ? ' — ' + result.error : ''),
    );
    break;
  }

  if (hardConflict) {
    const paths = writeMergeConflictArtifact(dir, hardConflict);
    report.artifact = paths.artifact;
    report.promptPath = paths.promptPath;
    state.status = 'merge_blocked';
    state.mergeConflict = hardConflict;
    state.updatedAt = Date.now();
    writeJsonPretty(path.join(dir, 'state.json'), state);

    // Default: attempt builder redispatch (rate-limited). Tests pass dispatchResolver:false.
    if (opts.dispatchResolver !== false) {
      const dispatch = dispatchMergeConflictResolver(
        opts.ctx || { skillRootDir: () => path.join(__dirname, '..') },
        repo,
        megaId,
        hardConflict,
        opts,
      );
      report.resolver = dispatch;
    }

    // Leave MAIN on default branch
    try {
      execFileSync('git', ['-C', repo, 'checkout', defaultBranch], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch { /* ignore */ }

    return { ok: false, ...report };
  }

  // Optional gates on integrate
  if (opts.gates && report.errors.length === 0) {
    const cmd = opts.gates;
    try {
      execFileSync('bash', ['-lc', cmd], {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      report.gates = { ok: true, cmd };
    } catch (err) {
      report.gates = { ok: false, cmd, error: String(err.stderr || err.message || err) };
      report.errors.push('gates failed');
      state.status = 'merge_blocked';
      state.mergeConflict = { kind: 'gates', error: report.gates.error, at: Date.now() };
      state.updatedAt = Date.now();
      writeJsonPretty(path.join(dir, 'state.json'), state);
      try {
        execFileSync('git', ['-C', repo, 'checkout', defaultBranch], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch { /* ignore */ }
      return { ok: false, ...report };
    }
  }

  if (opts.toMain && report.errors.length === 0) {
    try {
      execFileSync('git', ['-C', repo, 'checkout', defaultBranch], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      execFileSync(
        'git',
        [
          '-C', repo, 'merge', '--no-ff', integrate,
          '-m', 'swarm: mega ' + megaId + ' integrate → ' + defaultBranch,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      report.toMain = true;
      state.status = 'merged';
      delete state.mergeConflict;
      state.updatedAt = Date.now();
      writeJsonPretty(path.join(dir, 'state.json'), state);
    } catch (err) {
      tryAbortMerge(repo);
      report.errors.push('merge to main: ' + (err.stderr || err.message || err));
      state.status = 'merge_blocked';
      state.mergeConflict = {
        kind: 'to-main',
        integrate,
        error: String(err.stderr || err.message || err).slice(0, 500),
        at: Date.now(),
      };
      state.updatedAt = Date.now();
      writeJsonPretty(path.join(dir, 'state.json'), state);
      return { ok: false, ...report };
    }
  } else if (report.errors.length === 0) {
    // All packs on integrate; not on main yet
    state.status = 'integrated';
    delete state.mergeConflict;
    state.updatedAt = Date.now();
    writeJsonPretty(path.join(dir, 'state.json'), state);
    try {
      execFileSync('git', ['-C', repo, 'checkout', defaultBranch], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch { /* ignore */ }
  } else {
    try {
      execFileSync('git', ['-C', repo, 'checkout', defaultBranch], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch { /* ignore */ }
  }

  return { ok: report.errors.length === 0, ...report };
}

/**
 * Propose a mega plan by scanning directories under roots.
 *
 * Design rules (micro-pack default — fast wall-clock without sacrificing quality):
 * - Prefer ~20 small packs (1 dir when budget allows; chunk only to fit maxSubswarms)
 * - 1 builder per pack by default; scout only on visual_tier=full; logger deferred (0)
 * - Segment-safe paths only (lease overlap lives in mega.cjs pathsOverlap)
 * - Skip noise dirs (_template, __tests__, node_modules, …)
 * - Do NOT mark every child of `components/` as "shared" — only ui/shared/common
 * - Cap by **chunking** leftover dirs into bucket subswarms (never drop names that
 *   remain in depends_on)
 * - Recompute depends_on only after final name list is known
 * - visual_tier full|smoke|gates_only; thin shared depends_on (≤4, featureish)
 */
function proposePlan(repo, opts = {}) {
  const goal = opts.goal || 'Partitioned mega mission';
  const id = opts.id || ('mega-' + Date.now().toString(36));
  const roots = (opts.roots || ['src/features', 'src/components', 'convex/domains'])
    .map((r) => String(r).replace(/\/$/, ''));
  // Micro-pack defaults: 1 builder, up to 20 packs, chunk size 2 (prefer 1:1)
  const maxBuilders = Math.max(1, Number(opts.maxBuilders) || 1);
  const maxSubswarms = Math.max(3, Number(opts.maxSubswarms) || 20);
  // Preferred max dirs per pack when forced to chunk; always use needSize when larger
  const chunkSize = Math.max(1, Number(opts.chunkSize) || 2);
  const SKIP_DIR = /^(node_modules|__tests__|_template|\.git|dist|build|coverage|\.turbo)$/i;

  const raw = []; // { root, dirName, files, isShared }

  for (const root of roots) {
    const abs = path.join(repo, root);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP_DIR.test(d.name));
    } catch {
      continue;
    }
    if (entries.length === 0) {
      raw.push({
        root,
        dirName: root.split('/').pop() || 'root',
        files: [root + '/**'],
        isShared: /^(ui|shared|common)$/i.test(root.split('/').pop() || ''),
      });
      continue;
    }
    for (const d of entries) {
      const isShared = /^(ui|shared|common)$/i.test(d.name);
      raw.push({
        root,
        dirName: d.name,
        files: [root + '/' + d.name + '/**'],
        isShared,
      });
    }
    // Root-level files (e.g. src/components/*.tsx) — own slice so they aren't orphaned
    try {
      const rootFiles = fs.readdirSync(abs, { withFileTypes: true })
        .filter((d) => d.isFile() && /\.(tsx?|jsx?|css|scss)$/.test(d.name));
      if (rootFiles.length > 0) {
        raw.push({
          root,
          dirName: '_root-files',
          files: rootFiles.map((f) => root + '/' + f.name),
          isShared: false,
        });
      }
    } catch { /* ignore */ }
  }

  // Split shared vs parallel work
  let parallel = raw.filter((r) => !r.isShared);
  let shared = raw.filter((r) => r.isShared);

  // If too many parallel dirs, chunk by root first then globally
  function chunkItems(items, size) {
    const out = [];
    for (let i = 0; i < items.length; i += size) {
      out.push(items.slice(i, i + size));
    }
    return out;
  }

  // Budget: leave room for shared slices
  const sharedBudget = Math.min(shared.length || 0, 2);
  const parallelBudget = Math.max(1, maxSubswarms - Math.max(sharedBudget, 1));

  let parallelGroups;
  if (parallel.length <= parallelBudget) {
    // 1:1 micro-packs when we have coordinator budget
    parallelGroups = parallel.map((p) => [p]);
  } else {
    // Smallest dirs-per-pack that still fits in parallelBudget (micro-pack: avoid fat 6-packs).
    // chunkSize is a preferred minimum group size only when it does not explode pack count.
    let size = Math.max(1, Math.ceil(parallel.length / parallelBudget));
    if (chunkSize > size) {
      const trial = chunkItems(parallel, chunkSize);
      if (trial.length <= parallelBudget) size = chunkSize;
    }
    parallelGroups = chunkItems(parallel, size);
    while (parallelGroups.length > parallelBudget) {
      size = Math.ceil(parallel.length / parallelBudget);
      parallelGroups = chunkItems(parallel, size);
      if (size >= parallel.length) break;
    }
  }

  /** Scout only on full visual (expensive surfaces); skip ceremony on smoke/gates_only. */
  function scoutsForTier(tier) {
    return String(tier) === 'full' ? 1 : 0;
  }

  /** 1 builder for micro packs; allow up to maxBuilders when a pack is multi-dir. */
  function buildersForGroup(groupLen) {
    if (groupLen <= 1) return 1;
    return Math.min(maxBuilders, Math.max(1, Math.min(2, groupLen)));
  }

  const subswarms = [];
  const seen = new Set();

  function uniqueName(base) {
    let n = slugify(base).slice(0, 40);
    let i = 2;
    while (seen.has(n)) {
      n = (slugify(base).slice(0, 36) + '-' + i).slice(0, 48);
      i++;
    }
    seen.add(n);
    return n;
  }

  function heuristicVisualTier(files, rootsBlob) {
    const blob = String(rootsBlob || '') + ' ' + (Array.isArray(files) ? files.join(' ') : '');
    let visual_tier;
    if (/mobile|inbox|auth|landing/i.test(blob)) visual_tier = 'full';
    else if (/components|features/i.test(blob)) visual_tier = 'smoke';
    else visual_tier = 'gates_only';
    // Honor resolveVisualTier if caller already set an explicit tier on a stub
    return resolveVisualTier({ files, visual_tier });
  }

  for (const group of parallelGroups) {
    if (group.length === 1) {
      const p = group[0];
      const prefix = p.root.split('/').pop() || 'x';
      const files = p.files;
      const visual_tier = heuristicVisualTier(files, p.root + '/' + p.dirName);
      subswarms.push({
        name: uniqueName(prefix + '-' + p.dirName),
        title: p.root + '/' + p.dirName,
        files,
        builders: buildersForGroup(1),
        scouts: scoutsForTier(visual_tier),
        loggers: 0,
        visual_tier,
        visual_review: visual_tier !== 'gates_only',
        depends_on: [],
        floor: false,
      });
    } else {
      const prefix = group[0].root.split('/').pop() || 'bucket';
      const names = group.map((g) => g.dirName).slice(0, 4).join('-');
      const files = group.flatMap((g) => g.files);
      const rootsBlob = group.map((g) => g.root + '/' + g.dirName).join(' ');
      const visual_tier = heuristicVisualTier(files, rootsBlob);
      subswarms.push({
        name: uniqueName(prefix + '-pack-' + names),
        title: 'Packed: ' + group.map((g) => g.root + '/' + g.dirName).join(', '),
        files,
        builders: buildersForGroup(group.length),
        scouts: scoutsForTier(visual_tier),
        loggers: 0,
        visual_tier,
        visual_review: visual_tier !== 'gates_only',
        depends_on: [],
        floor: false,
      });
    }
  }

  // Shared last — thin depends_on (feature packs preferred, cap ≤4)
  for (const s of shared) {
    const prefix = s.root.split('/').pop() || 'x';
    const files = s.files;
    const visual_tier = heuristicVisualTier(files, s.root + '/' + s.dirName);
    subswarms.push({
      name: uniqueName(prefix + '-' + s.dirName),
      title: s.root + '/' + s.dirName + ' (shared — after features)',
      files,
      builders: 1,
      scouts: scoutsForTier(visual_tier),
      loggers: 0,
      visual_tier,
      visual_review: visual_tier !== 'gates_only',
      depends_on: [], // filled below
      floor: !!opts.floorTiny,
    });
  }

  // If no shared but we want a styles/locales closer — optional roots already handled

  const parallelNames = subswarms
    .filter((s) => !(s.title || '').includes('(shared'))
    .map((s) => s.name);
  for (const s of subswarms) {
    if ((s.title || '').includes('(shared')) {
      // Prefer feature packs; never depend on every parallel pack when N>4
      const featureish = parallelNames.filter((n) => /feature/i.test(n));
      let prefer = featureish.length
        ? featureish
        : parallelNames.slice(0, Math.min(4, parallelNames.length));
      if (prefer.length > 4) prefer = prefer.slice(0, 4);
      s.depends_on = prefer;
      s.visual_tier = resolveVisualTier(s);
      if (s.visual_tier === 'gates_only') s.visual_review = false;
      else s.visual_review = true;
    }
  }

  // Hard safety: drop any depends_on that aren't in the final set
  const nameSet = new Set(subswarms.map((s) => s.name));
  for (const s of subswarms) {
    s.depends_on = (s.depends_on || []).filter((d) => nameSet.has(d) && d !== s.name);
  }

  const plan = {
    id: slugify(id).slice(0, 48),
    goal,
    default_branch: detectDefaultBranch(repo),
    integrate_branch: 'swarm/integrate/' + slugify(id).slice(0, 40),
    // Sized for ~20 concurrent micro-teams on a dedicated FE host
    capacity: {
      max_builders: 30,
      max_coordinators: 16,
      max_reviewers: 12,
      max_scouts: 8,
      max_loggers: 4,
      max_visual_reviewers: 8,
      max_dev_servers: 10,
      ram_reserve_gb: 4,
    },
    worktree_seed: {
      copy_from_main: ['.env.local', '.env', 'playwright/.auth/user.json'],
      required: [],
    },
    subswarms: subswarms.length ? subswarms : [{
      name: 'main-slice',
      files: ['src/**'],
      builders: 1,
      scouts: 0,
      loggers: 0,
      visual_tier: 'smoke',
      visual_review: true,
      depends_on: [],
    }],
  };
  // Ensure every sub has a valid visual_tier + lean role counts
  for (const s of plan.subswarms) {
    s.visual_tier = resolveVisualTier(s);
    if (!VISUAL_TIERS.includes(s.visual_tier)) s.visual_tier = 'smoke';
    if (s.visual_tier === 'gates_only') s.visual_review = false;
    else if (s.visual_review === undefined) s.visual_review = true;
    if (s.scouts == null) s.scouts = scoutsForTier(s.visual_tier);
    if (s.loggers == null) s.loggers = 0;
    if (s.builders == null || s.builders < 1) s.builders = 1;
  }
  return plan;
}

function slugify(s) {
  return String(s || 'x')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'x';
}

function detectDefaultBranch(repo) {
  try {
    const ref = execFileSync('git', ['-C', repo, 'symbolic-ref', 'refs/remotes/origin/HEAD'], {
      encoding: 'utf8',
    }).trim();
    const m = ref.match(/refs\/remotes\/origin\/(.+)/);
    if (m) return m[1];
  } catch { /* ignore */ }
  for (const b of ['master', 'main']) {
    const r = spawnSync('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/' + b]);
    if (r.status === 0) return b;
  }
  return 'master';
}

function megaStatePayload(registryRoot, megaId) {
  const dir = megaDir(registryRoot, megaId);
  const plan = readJsonSafe(path.join(dir, 'plan.json'), null);
  const state = readJsonSafe(path.join(dir, 'state.json'), null);
  const daemon = readJsonSafe(path.join(dir, 'daemon.pid'), null);
  return {
    megaId,
    plan: plan && {
      goal: plan.goal,
      capacity: plan.capacity,
      integrate_branch: plan.integrate_branch,
      default_branch: plan.default_branch,
      subswarmCount: (plan.subswarms || []).length,
    },
    state,
    daemon: daemon && { pid: daemon.pid, alive: isAlive(daemon.pid), startedAt: daemon.startedAt },
  };
}

function listMegas(registryRoot) {
  const root = path.join(registryRoot, 'mega');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((n) => {
    if (n === 'archive' || n.startsWith('archive')) return false;
    return fs.existsSync(path.join(root, n, 'plan.json'));
  });
}

/**
 * Wire runtime commands into mega command dispatcher.
 * ctx must provide: die, parseArgs, skillRootDir, buildWorkspace, readState, launchCommand, megaLaunch, megaMark helpers via closures
 */
function attachRuntimeCommands(api, ctx) {
  const { die, parseArgs } = ctx;

  function resolveRepo(args) {
    const repoArg = args.repo || args.cwd || args._.find((x) => x && !String(x).startsWith('--')) || process.cwd();
    return path.resolve(repoArg);
  }

  function resolveMegaId(args, registryRoot) {
    const id =
      (args.id && args.id !== 'true' ? args.id : null) ||
      process.env.MEGA_ID ||
      null;
    if (id) return id;
    const ids = listMegas(registryRoot);
    if (ids.length === 1) return ids[0];
    return null;
  }

  api.megaVisual = function megaVisual(argv) {
    const args = parseArgs(argv);
    const repo = resolveRepo(args);
    const registryRoot = path.join(repo, '.grok-swarm');
    const megaId = resolveMegaId(args, registryRoot);
    const sub = args.sub && args.sub !== 'true' ? args.sub : null;
    const action = args._[0] || args.action || 'check';
    if (!megaId) die('Usage: swarm mega visual check|pass --id <mega> --sub <name>');
    const state = readJsonSafe(path.join(megaDir(registryRoot, megaId), 'state.json'), null);
    if (!state) die('no mega state');
    const name = sub || Object.keys(state.subswarms)[0];
    const swarmId = state.subswarms[name] && state.subswarms[name].swarmId;
    if (!swarmId) die('unknown sub');
    if (action === 'pass' || args.pass === 'true') {
      writeVisualPass(registryRoot, swarmId, args.note || 'manual visual pass');
      console.log('Wrote PASS for ' + name + ' → ' + reviewArtifactsDir(registryRoot, swarmId));
      return;
    }
    const subState = state.subswarms[name] || {};
    const required = shouldRequireReviewResult(resolveVisualTier(subState));
    const gate = checkVisualGate(registryRoot, swarmId, { required });
    if (args.json === 'true') console.log(JSON.stringify(gate, null, 2));
    else console.log(gate.ok ? 'PASS visual gate: ' + name : 'FAIL: ' + gate.reason);
    process.exitCode = gate.ok ? 0 : 1;
  };

  api.megaMerge = function megaMerge(argv) {
    const args = parseArgs(argv);
    const repo = resolveRepo(args);
    const registryRoot = path.join(repo, '.grok-swarm');
    const megaId = resolveMegaId(args, registryRoot);
    if (!megaId) die('Usage: swarm mega merge --id <mega> [--to-main] [--gates "cmd"] [--skip-visual-gate] [--no-dispatch-resolver]');
    const report = mergeIntegrate(repo, megaId, {
      toMain: args['to-main'] === 'true',
      gates: args.gates && args.gates !== 'true' ? args.gates : null,
      skipVisualGate: args['skip-visual-gate'] === 'true',
      dispatchResolver: args['no-dispatch-resolver'] !== 'true',
      ctx,
    });
    if (args.json === 'true') console.log(JSON.stringify(report, null, 2));
    else {
      console.log('Mega merge ' + megaId + ': ' + (report.ok ? 'OK' : 'FAILED'));
      console.log('  integrate: ' + report.integrate);
      console.log('  merged: ' + (report.merged || []).join(', '));
      if (report.skipped && report.skipped.length) {
        for (const s of report.skipped) console.log('  skip ' + s.name + ': ' + s.reason);
      }
      if (report.unionRetried && report.unionRetried.length) {
        for (const u of report.unionRetried) {
          console.log('  union-retry ' + u.name + ': ' + (u.files || []).join(', '));
        }
      }
      if (report.needsResolve) {
        console.log('  needsResolve: true (status=merge_blocked; see .grok-swarm/mega/' + megaId + '/merge-conflict.json)');
        if (report.resolver) {
          console.log('  resolver: ' + JSON.stringify(report.resolver));
        }
      }
      if (report.toMain) console.log('  merged to main/default branch');
      for (const e of report.errors || []) console.log('  error: ' + e);
    }
    process.exitCode = report.ok ? 0 : 1;
  };

  api.megaPropose = function megaPropose(argv) {
    const args = parseArgs(argv);
    const repo = resolveRepo(args);
    const roots = args.roots && args.roots !== 'true'
      ? String(args.roots).split(',').map((s) => s.trim())
      : undefined;
    const plan = proposePlan(repo, {
      goal: args.goal && args.goal !== 'true' ? args.goal : 'Proposed mega partition',
      id: args.id && args.id !== 'true' ? args.id : undefined,
      roots,
      maxBuilders: args.builders ? Number(args.builders) : 1,
      maxSubswarms: args.packs ? Number(args.packs) : args['max-packs'] ? Number(args['max-packs']) : 20,
      chunkSize: args['chunk-size'] ? Number(args['chunk-size']) : 2,
      floorTiny: args['floor-tiny'] === 'true',
    });
    // validate via ctx if available
    if (ctx.validatePlan) {
      const problems = ctx.validatePlan(plan);
      if (problems.length && args.force !== 'true') {
        console.error('Proposed plan has problems (use --force to write anyway):');
        for (const p of problems) console.error('  - ' + p.message);
      }
    }
    const outPath = args.out && args.out !== 'true'
      ? path.resolve(args.out)
      : path.join(repo, '.grok-swarm', 'mega-proposed-' + plan.id + '.json');
    if (args['print-only'] === 'true') {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    writeJsonPretty(outPath, plan);
    console.log('Wrote proposed plan: ' + outPath);
    console.log('  subswarms: ' + plan.subswarms.map((s) => s.name).join(', '));
    console.log('Next: swarm mega write-plan --plan ' + outPath + ' --repo ' + repo);
  };

  api.megaTick = function megaTick(argv) {
    const args = parseArgs(argv);
    const repo = resolveRepo(args);
    const registryRoot = path.join(repo, '.grok-swarm');
    const megaId = resolveMegaId(args, registryRoot);
    if (!megaId) die('Usage: swarm mega tick --id <mega> [--force-visual-pass] [--json]');
    const rec = reconcileMega(ctx, repo, megaId, {
      forceVisualPass: args['force-visual-pass'] === 'true',
      dryRun: args['dry-run'] === 'true',
      restartCoordinator: args['no-restart'] !== 'true',
    });
    // Auto-launch queued if capacity free (quiet so --json ticks stay parseable).
    // Skip re-entry when D4 peer-lease-clash just blocked a sub this tick.
    const leaseBlocked = (rec.actions || []).some((a) => a.type === 'peer-lease-clash');
    if (rec.ok && ctx.megaLaunchFn && !leaseBlocked) {
      try {
        ctx.megaLaunchFn([
          '--id', megaId,
          '--repo', repo,
          '--quiet',
          ...(args['no-coordinator'] === 'true' ? ['--no-coordinator'] : []),
          '--force',
        ]);
        rec.launched = true;
      } catch (err) {
        rec.launchError = String(err.message || err);
      }
    } else if (leaseBlocked) {
      rec.launched = false;
      rec.launchSkipped = 'peer-lease-clash';
    }
    // Auto-merge when packs done and --auto-merge.
    // Also retry while status is merge_blocked (idempotent: skips already-merged).
    const st = rec.state || {};
    const shouldMerge =
      args['auto-merge'] === 'true' &&
      (rec.allDone || st.status === 'merge_blocked' || st.status === 'completed');
    if (shouldMerge && st.status !== 'merged' && st.status !== 'integrated') {
      rec.merge = mergeIntegrate(repo, megaId, {
        toMain: args['to-main'] === 'true',
        gates: args.gates && args.gates !== 'true' ? args.gates : null,
        dispatchResolver: args['no-dispatch-resolver'] !== 'true',
        ctx,
      });
      // Refresh state after merge side-effects
      rec.state = readJsonSafe(path.join(megaDir(registryRoot, megaId), 'state.json'), rec.state);
      rec.mergeOk = !!(rec.merge && rec.merge.ok);
      rec.fullyDone = !!(rec.merge && rec.merge.ok);
    } else if (st.status === 'merged' || st.status === 'integrated') {
      rec.mergeOk = true;
      rec.fullyDone = true;
    } else {
      rec.fullyDone = false;
    }
    if (args.json === 'true') console.log(JSON.stringify(rec, null, 2));
    else {
      console.log('Mega tick ' + megaId + ': actions=' + (rec.actions || []).length +
        (rec.allDone ? ' ALL_DONE' : '') +
        (rec.merge && rec.merge.ok === false ? ' MERGE_BLOCKED' : '') +
        (rec.fullyDone ? ' FULLY_DONE' : ''));
      for (const a of rec.actions || []) {
        console.log('  - ' + a.type + (a.sub ? ' ' + a.sub : '') + (a.reason ? ' (' + a.reason + ')' : ''));
      }
    }
    return rec;
  };

  api.megaRun = function megaRun(argv) {
    const args = parseArgs(argv);
    const repo = resolveRepo(args);
    const registryRoot = path.join(repo, '.grok-swarm');
    const megaId = resolveMegaId(args, registryRoot);
    if (!megaId) die('Usage: swarm mega run --id <mega> [--daemon] [--interval 20] [--auto-merge] [--to-main] [--gates cmd] [--force-visual-pass]');

    const dir = megaDir(registryRoot, megaId);
    const intervalMs = Math.max(5, Number(args.interval) || 20) * 1000;
    const logFile = path.join(dir, 'daemon.log');
    const pidFile = path.join(dir, 'daemon.pid');

    if (args.stop === 'true' || args._[0] === 'stop') {
      const rec = readJsonSafe(pidFile, null);
      if (rec && rec.pid && isAlive(rec.pid)) {
        try { process.kill(rec.pid, 'SIGTERM'); } catch { /* ignore */ }
        console.log('Stopped mega daemon pid ' + rec.pid);
      } else console.log('No running mega daemon');
      try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
      return;
    }

    if (args.status === 'true' || args._[0] === 'status') {
      const rec = readJsonSafe(pidFile, null);
      const alive = rec && isAlive(rec.pid);
      if (args.json === 'true') {
        console.log(JSON.stringify({ running: !!alive, rec }, null, 2));
      } else {
        console.log(alive
          ? 'Mega daemon running: pid ' + rec.pid + ' mega=' + megaId + ' log=' + logFile
          : 'Mega daemon not running for ' + megaId);
      }
      process.exitCode = alive ? 0 : 1;
      return;
    }

    const tickArgs = [
      '--id', megaId,
      '--repo', repo,
      ...(args['force-visual-pass'] === 'true' ? ['--force-visual-pass'] : []),
      ...(args['auto-merge'] === 'true' ? ['--auto-merge'] : []),
      ...(args['to-main'] === 'true' ? ['--to-main'] : []),
      ...(args.gates && args.gates !== 'true' ? ['--gates', args.gates] : []),
      ...(args['no-coordinator'] === 'true' ? ['--no-coordinator'] : []),
    ];

    if (args.daemon === 'true') {
      const existing = readJsonSafe(pidFile, null);
      if (existing && isAlive(existing.pid)) {
        console.log('Mega daemon already running: pid ' + existing.pid);
        // Ensure healer is up alongside an already-running mega daemon
        if (args['no-healer'] !== 'true') {
          try {
            execFileSync(
              process.execPath,
              [
                path.join(ctx.skillRootDir(), 'bin', 'swarm.cjs'),
                'heal',
                'start',
                '--daemon',
                '--repo',
                repo,
                '--interval',
                '30',
                ...(args['auto-visual-pass'] === 'true' ? ['--auto-visual-pass'] : []),
              ],
              {
                cwd: repo,
                env: { ...process.env, SWARM_AGENT_NAME: 'Healer' },
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
              },
            );
          } catch {
            /* ignore */
          }
        }
        return;
      }
      const childArgs = [
        path.join(ctx.skillRootDir(), 'bin', 'swarm.cjs'),
        'mega', 'run',
        '--id', megaId,
        '--repo', repo,
        '--interval', String(args.interval || 20),
        '--_daemon-child',
        ...(args['force-visual-pass'] === 'true' ? ['--force-visual-pass'] : []),
        ...(args['auto-merge'] === 'true' ? ['--auto-merge'] : []),
        ...(args['to-main'] === 'true' ? ['--to-main'] : []),
        ...(args.gates && args.gates !== 'true' ? ['--gates', args.gates] : []),
      ];
      const logFd = fs.openSync(logFile, 'a');
      const child = spawn(process.execPath, childArgs, {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env, SWARM_AGENT_NAME: 'Coordinator', MEGA_ID: megaId },
      });
      child.unref();
      fs.closeSync(logFd);
      writeJsonPretty(pidFile, {
        pid: child.pid,
        megaId,
        repo,
        logFile,
        startedAt: Date.now(),
      });
      // Start self-monitor healer (safe defaults) unless disabled
      if (args['no-healer'] !== 'true') {
        try {
          execFileSync(
            process.execPath,
            [
              path.join(ctx.skillRootDir(), 'bin', 'swarm.cjs'),
              'heal',
              'start',
              '--daemon',
              '--repo',
              repo,
              '--interval',
              '30',
              ...(args['auto-visual-pass'] === 'true' ? ['--auto-visual-pass'] : []),
            ],
            {
              cwd: repo,
              env: { ...process.env, SWARM_AGENT_NAME: 'Healer' },
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );
          console.log('Healer: swarm heal status --repo ' + repo);
        } catch (err) {
          console.log('WARNING: healer start failed: ' + String(err.message || err));
        }
      }
      console.log('Mega daemon started: pid ' + child.pid);
      console.log('  log: ' + logFile);
      console.log('  stop: swarm mega run --id ' + megaId + ' --stop');
      return;
    }

    // Foreground loop (or daemon child)
    appendLog(logFile, 'mega run start interval=' + intervalMs);
    const maxTicks = args['max-ticks'] ? Number(args['max-ticks']) : (args['_daemon-child'] === 'true' ? 100000 : 1);
    // If not daemon child and not explicitly looping, single tick unless --loop
    const loop = args.loop === 'true' || args['_daemon-child'] === 'true';
    let ticks = 0;
    function once() {
      ticks++;
      try {
        const rec = api.megaTick(tickArgs.concat(args.json === 'true' ? ['--json'] : []));
        appendLog(logFile, 'tick ' + ticks + ' actions=' + ((rec && rec.actions) || []).length +
          (rec && rec.allDone ? ' ALL_DONE' : '') +
          (rec && rec.merge && rec.merge.ok === false ? ' MERGE_BLOCKED' : '') +
          (rec && rec.fullyDone ? ' FULLY_DONE' : ''));
        // Only exit when packs are done AND integrate merge succeeded (or auto-merge off).
        // Failed auto-merge → status merge_blocked; keep looping so retries/union/builder can finish.
        const autoMerge = args['auto-merge'] === 'true';
        if (rec && rec.allDone && autoMerge) {
          appendLog(logFile, 'auto-merge ' + JSON.stringify(rec.merge || {}));
          if (!rec.fullyDone) {
            appendLog(
              logFile,
              'auto-merge incomplete (merge_blocked or needsResolve) — staying alive for retry; see merge-conflict.json',
            );
            // continue loop
          } else {
            if (args['auto-cleanup'] === 'true') {
              try {
                ctx.megaCleanupFn([
                  '--id', megaId, '--repo', repo, '--full', '--json',
                ]);
                appendLog(logFile, 'auto-cleanup done');
              } catch (err) {
                appendLog(logFile, 'auto-cleanup failed: ' + err.message);
              }
            }
            appendLog(logFile, 'mega completed — exiting run loop');
            try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
            process.exit(0);
          }
        } else if (rec && rec.allDone && !autoMerge) {
          // Packs done, no auto-merge requested — historical behavior
          appendLog(logFile, 'mega packs done (no auto-merge) — exiting run loop');
          try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
          process.exit(0);
        }
      } catch (err) {
        appendLog(logFile, 'tick error: ' + (err && err.message || err));
      }
      if (!loop || ticks >= maxTicks) {
        if (args['_daemon-child'] === 'true') {
          // continue
        } else if (!loop) {
          return;
        }
      }
      if (loop && ticks < maxTicks) {
        setTimeout(once, intervalMs);
      }
    }
    if (loop) {
      once();
      // keep event loop alive
      if (args['_daemon-child'] === 'true' || args.loop === 'true') {
        // setTimeout chain keeps process alive
      }
    } else {
      // single tick via megaTick
      api.megaTick(tickArgs);
    }
  };

  api.checkVisualGate = checkVisualGate;
  api.mergeIntegrate = mergeIntegrate;
  api.proposePlan = proposePlan;
  api.megaStatePayload = megaStatePayload;
  api.listMegas = listMegas;
  api.reconcileMega = reconcileMega;
}

module.exports = {
  checkVisualGate,
  writeVisualPass,
  mergeIntegrate,
  mergeOneBranch,
  isUnionMergeSafePath,
  UNION_MERGE_SAFE_PATTERNS,
  proposePlan,
  megaStatePayload,
  listMegas,
  reconcileMega,
  attachRuntimeCommands,
  reviewArtifactsDir,
  queuedReason,
  visualAgeMsForSub,
  maybeAgeVisualPass,
  doubleCheckCompleteForBoard,
  recheckPeerLeases,
};
