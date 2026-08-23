/**
 * grok-swarm self-monitor / healer
 *
 * Mechanical health agent (no LLM): polls the registry, heals board/process drift,
 * optionally restarts daemons, and writes a journal under .grok-swarm/heal/.
 *
 * Incident drivers (2026-07-14 mega-fe):
 *  - dispatch left status=running after PID exit → multi-hour "(exited?)" ghosts
 *  - coordinator/dashboard/mega daemons die mid-mission
 *  - visual review_result BLOCKED (auth/proxy) never promoted / pack stuck in review
 *
 * Zero third-party deps. Used by: swarm heal …
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync, spawnSync } = require('child_process');
const {
  isAuthOnlyBlocked,
  isForcePassEligible,
  classifyReviewResult,
  DEFAULT_MAX_VISUAL_AGE_MS,
} = require('./visual-policy.cjs');
const { EDGES, isAutoSafe } = require('./edge-matrix.cjs');

/** Stall-restart rate limit: 1 per 10 minutes per swarm. */
const STALL_RESTART_COOLDOWN_MS = 10 * 60 * 1000;

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
  } catch {
    /* ignore */
  }
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

function listSwarmIds(registryRoot) {
  const swarmsDir = path.join(registryRoot, 'swarms');
  if (!fs.existsSync(swarmsDir)) return [];
  return fs
    .readdirSync(swarmsDir)
    .filter((name) => {
      const p = path.join(swarmsDir, name);
      try {
        return fs.statSync(p).isDirectory() && !name.startsWith('archive');
      } catch {
        return false;
      }
    })
    .sort();
}

function listActiveMegas(registryRoot) {
  const mroot = path.join(registryRoot, 'mega');
  if (!fs.existsSync(mroot)) return [];
  const out = [];
  for (const id of fs.readdirSync(mroot)) {
    if (id === 'archive' || id.startsWith('archive')) continue;
    const st = readJsonSafe(path.join(mroot, id, 'state.json'), null);
    // merge_blocked: packs done but integrate conflict — keep healer watching / restart meta
    if (
      st &&
      (st.status === 'running' ||
        st.status === 'queued' ||
        st.status === 'merge_blocked' ||
        st.status === 'completed')
    ) {
      out.push({ megaId: id, state: st, dir: path.join(mroot, id) });
    }
  }
  return out;
}

/** Find the newest review_result.json under a swarm workspace. */
function findReviewResults(swarmRoot) {
  const candidates = [];
  const roots = [
    path.join(swarmRoot, 'review-artifacts'),
    path.join(swarmRoot, 'artifacts'),
  ];
  function walk(dir, depth) {
    if (depth > 4 || !fs.existsSync(dir)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isFile() && ent.name === 'review_result.json') {
        const j = readJsonSafe(p, null);
        if (j) {
          let mtime = 0;
          try {
            mtime = fs.statSync(p).mtimeMs;
          } catch {
            /* ignore */
          }
          candidates.push({ path: p, result: j, mtime });
        }
      } else if (ent.isDirectory()) {
        walk(p, depth + 1);
      }
    }
  }
  for (const r of roots) walk(r, 0);
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates;
}

/**
 * Infer whether code gates look green for force-pass eligibility.
 * Prefer explicit review_result fields; else DC-complete + no building tasks.
 */
function inferCodeGatesGreen(result, openTasks) {
  if (result && result.codeGatesGreen === true) return true;
  if (result && result.codeGatesGreen === 'green') return true;
  const summary = String((result && result.summary) || '');
  if (/gates?\s*ok|typecheck\s*ok|ui:policy/i.test(summary)) return true;
  const tasks = Array.isArray(openTasks) ? openTasks : [];
  const hasBuilding = tasks.some((t) => String(t.status || '') === 'building');
  const doubleCheckComplete =
    String((result && result.doubleCheck) || '').toLowerCase() === 'complete' ||
    (result && result.doubleCheck === true);
  // DC complete implies builders already verified gates; still refuse while building.
  if (doubleCheckComplete && !hasBuilding) return true;
  const nonTerminal = tasks.filter((t) => !['done', 'cancelled'].includes(String(t.status || '')));
  return nonTerminal.length === 0;
}

/** Thin readdir of ws.dispatches — no swarm.cjs injection needed. */
function readDispatchesLocal(ws) {
  const dir = (ws && ws.dispatches) || (ws && ws.root ? path.join(ws.root, 'dispatches') : null);
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function isVisualAgentLabel(label) {
  return /visual|reviewer/i.test(String(label || ''));
}

function isBuilderAgentLabel(label) {
  const s = String(label || '');
  if (isVisualAgentLabel(s)) return false;
  if (/coordinator|healer|logger|scout/i.test(s)) return false;
  return /builder|fix|implement/i.test(s) || s.length > 0;
}

/** Hard double-check: file with "Double-check result: complete" under registry or swarm. */
function hasHardDoubleCheck(repo, swarmRoot) {
  const roots = [
    path.join(repo, '.grok-swarm', 'double-check'),
    swarmRoot ? path.join(swarmRoot, 'double-check') : null,
  ].filter(Boolean);
  const re = /Double-check\s+result:\s*complete/i;
  for (const dir of roots) {
    if (!fs.existsSync(dir)) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!/\.md$/i.test(name)) continue;
      try {
        const text = fs.readFileSync(path.join(dir, name), 'utf8');
        if (re.test(text)) return true;
      } catch {
        /* ignore */
      }
    }
  }
  return false;
}

/**
 * Hard code-gates green for C5 no-result path (fail closed without explicit signal).
 * Accepts code-gates-green.json {ok|green:true} or bare code-gates-green file.
 */
function hasHardCodeGatesGreen(repo) {
  const j = readJsonSafe(path.join(repo, '.grok-swarm', 'code-gates-green.json'), null);
  if (j && (j.ok === true || j.green === true || j.codeGatesGreen === true)) return true;
  const bare = path.join(repo, '.grok-swarm', 'code-gates-green');
  if (fs.existsSync(bare)) {
    try {
      const t = fs.readFileSync(bare, 'utf8').trim().toLowerCase();
      if (!t || t === '1' || t === 'true' || t === 'ok' || t === 'green') return true;
    } catch {
      return true;
    }
  }
  return false;
}

function stallRestartStatePath(healDir) {
  return path.join(healDir, 'stall-restart.json');
}

function canStallRestart(healDir, swarmId, now) {
  const st = readJsonSafe(stallRestartStatePath(healDir), {});
  const last = st[swarmId];
  if (last == null || !Number.isFinite(Number(last))) return true;
  return now - Number(last) >= STALL_RESTART_COOLDOWN_MS;
}

function markStallRestart(healDir, swarmId, now) {
  const p = stallRestartStatePath(healDir);
  const st = readJsonSafe(p, {});
  st[swarmId] = now;
  writeJsonPretty(p, st);
}

/**
 * D1: cancelled tasks whose dependsOn reference missing task IDs → clear dependsOn.
 */
function scrubCancelledBrokenDeps(ctx, repo, ws, board, dryRun, act, swarmCjs) {
  const tasks = (board && board.tasks) || [];
  if (!tasks.length) return;
  const byId = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    if (String(t.status || '') !== 'cancelled') continue;
    const deps = Array.isArray(t.dependsOn) ? t.dependsOn : [];
    if (!deps.length) continue;
    const missing = deps.filter((d) => !byId.has(d));
    if (!missing.length) continue;
    act('cancelled-dep-scrub', {
      swarmId: ws.swarmId,
      taskId: t.id,
      edgeId: 'D1',
      missing,
      healAction: EDGES.D1 && EDGES.D1.healAction,
    });
    if (dryRun) continue;
    if (!isAutoSafe('D1')) continue;
    try {
      // Bare --depends → list() returns [] (clears dependsOn)
      execFileSync(
        process.execPath,
        [swarmCjs, 'task', 'update', '--id', t.id, '--depends', '--swarm', ws.swarmId, '--cwd', repo],
        {
          cwd: repo,
          env: { ...process.env, SWARM_AGENT_NAME: 'Healer', SWARM_ID: ws.swarmId },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    } catch (err) {
      act('cancelled-dep-scrub-failed', {
        swarmId: ws.swarmId,
        taskId: t.id,
        edgeId: 'D1',
        error: String((err.stderr || err.message || err)).slice(0, 400),
      });
    }
  }
}

/**
 * C5: visual dispatch dead, no review_result, age >12m, hard gates+DC → force-pass.
 */
function tryVisualNoResultAgePass(opts) {
  const {
    ws,
    repo,
    openTasks,
    reviews,
    autoVisualPass,
    dryRun,
    now,
    act,
  } = opts;
  if (reviews.length) return; // existing artifact path handles force-pass
  if (!autoVisualPass) {
    // Still note if we would consider it
    const dispatches = readDispatchesLocal(ws);
    const visualDead = dispatches.filter((d) => {
      if (!isVisualAgentLabel(d.agentLabel)) return false;
      if (d.status === 'running' && isAlive(d.pid)) return false;
      return true;
    });
    if (visualDead.length) {
      act('visual-no-result', {
        swarmId: ws.swarmId,
        edgeId: 'C5',
        count: visualDead.length,
        hint: 'dead visual without review_result — pass --auto-visual-pass when gates+DC green and age>12m',
      });
    }
    return;
  }

  const dispatches = readDispatchesLocal(ws);
  const maxAge = DEFAULT_MAX_VISUAL_AGE_MS;
  let oldestEligible = null;
  for (const d of dispatches) {
    if (!isVisualAgentLabel(d.agentLabel)) continue;
    // Must be dead / terminal — not a live running visual
    if (d.status === 'running' && isAlive(d.pid)) continue;
    if (d.status === 'running' && !isAlive(d.pid)) {
      /* dead PID left running — eligible by age */
    }
    const ts = Number(d.updatedAt || d.createdAt || 0);
    const age = ts > 0 ? now - ts : 0;
    if (age < maxAge) continue;
    if (!oldestEligible || age > oldestEligible.age) {
      oldestEligible = { dispatch: d, age };
    }
  }
  if (!oldestEligible) return;

  const hardDC = hasHardDoubleCheck(repo, ws.root);
  const hardGates = hasHardCodeGatesGreen(repo);
  const hasBuilding = openTasks.some((t) => String(t.status || '') === 'building');
  if (!hardDC || !hardGates || hasBuilding) {
    act('visual-no-result-age-pass-eval', {
      swarmId: ws.swarmId,
      edgeId: 'C5',
      eligible: false,
      reason: !hardDC
        ? 'double-check not complete (hard file)'
        : !hardGates
          ? 'code gates not green (hard signal)'
          : 'builders still building',
      ageSec: Math.round(oldestEligible.age / 1000),
    });
    return;
  }

  const synthetic = {
    status: 'BLOCKED',
    summary: 'no review_result, visual dead (healer C5 age-pass)',
    findings: [
      {
        severity: 'info',
        area: 'harness',
        message: 'visual PID dead without review_result past max age',
      },
    ],
    routesChecked: [],
    doubleCheck: 'complete',
    codeGatesGreen: true,
  };
  const eligibility = isForcePassEligible({
    result: synthetic,
    codeGatesGreen: true,
    doubleCheckComplete: true,
    visualAgeMs: oldestEligible.age,
  });
  act('visual-no-result-age-pass-eval', {
    swarmId: ws.swarmId,
    edgeId: 'C5',
    eligible: eligibility.ok,
    reason: eligibility.reason,
    ageSec: Math.round(oldestEligible.age / 1000),
    dispatchId: oldestEligible.dispatch.id,
  });
  if (!eligibility.ok || dryRun) return;
  if (!isAutoSafe('C5')) return;

  const gatePath = path.join(ws.root, 'review-artifacts', 'review_result.json');
  try {
    writeJsonPretty(gatePath, {
      status: 'PASS',
      summary:
        'healer force-pass: visual-no-result-age-pass — ' +
        eligibility.reason +
        ' ageSec=' +
        Math.round(oldestEligible.age / 1000),
      findings: synthetic.findings,
      routesChecked: [],
      doubleCheck: 'complete',
      healer: true,
      originalStatus: 'MISSING',
      healedAt: new Date().toISOString(),
      edgeId: 'C5',
      healAction: EDGES.C5 && EDGES.C5.healAction,
    });
    act('visual-no-result-age-pass', {
      swarmId: ws.swarmId,
      edgeId: 'C5',
      gatePath,
      reason: eligibility.reason,
      healAction: EDGES.C5 && EDGES.C5.healAction,
    });
  } catch (err) {
    act('visual-no-result-age-pass-failed', {
      swarmId: ws.swarmId,
      edgeId: 'C5',
      error: String(err.message || err),
    });
  }
}

/**
 * One heal pass over a registry.
 * @param {object} ctx - injects from swarm.cjs: reconcileDeadDispatches, buildWorkspace, skillRootDir, parseArgs helpers
 */
function healTick(ctx, repo, opts) {
  const options = opts || {};
  const dryRun = options.dryRun === true;
  const restartDaemons = options.restartDaemons !== false;
  const autoVisualPass = options.autoVisualPass === true;
  const restartMega = options.restartMega === true;
  const restartCoordinators = options.restartCoordinators !== false;
  const now = Date.now();
  const registryRoot = path.join(repo, '.grok-swarm');
  const healDir = path.join(registryRoot, 'heal');
  const actions = [];
  const notes = [];
  const skillRoot = ctx.skillRootDir();
  const swarmCjs = path.join(skillRoot, 'bin', 'swarm.cjs');

  function act(type, detail) {
    const a = { type, at: now, ...(detail || {}) };
    actions.push(a);
    return a;
  }

  // --- 1. Dashboard liveness ---
  const dashPidFile = path.join(registryRoot, 'dashboard.pid');
  const dashRec = readJsonSafe(dashPidFile, null);
  if (dashRec && dashRec.pid && !isAlive(dashRec.pid)) {
    act('dashboard-dead', { pid: dashRec.pid });
    if (restartDaemons && !dryRun) {
      try {
        execFileSync(process.execPath, [swarmCjs, 'dashboard', '--daemon', '--cwd', repo, '--port', String(dashRec.port || 4599)], {
          cwd: repo,
          env: { ...process.env, SWARM_AGENT_NAME: 'Healer' },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        act('dashboard-restarted', { port: dashRec.port || 4599 });
      } catch (err) {
        act('dashboard-restart-failed', { error: String(err.message || err) });
      }
    }
  } else if (!dashRec || !dashRec.pid) {
    // Only restart if any swarm still has non-terminal work
    const activeWork = listSwarmIds(registryRoot).some((sid) => {
      try {
        const ws = ctx.buildWorkspace(registryRoot, sid);
        const st = ctx.readState(ws);
        return (st.tasks || []).some((t) => !['done', 'cancelled'].includes(t.status));
      } catch {
        return false;
      }
    });
    if (activeWork) {
      notes.push('dashboard not running while tasks open');
      act('dashboard-missing', {});
      if (restartDaemons && !dryRun) {
        try {
          execFileSync(process.execPath, [swarmCjs, 'dashboard', '--daemon', '--cwd', repo], {
            cwd: repo,
            env: { ...process.env, SWARM_AGENT_NAME: 'Healer' },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          act('dashboard-started', {});
        } catch (err) {
          act('dashboard-start-failed', { error: String(err.message || err) });
        }
      }
    }
  } else {
    notes.push('dashboard ok pid ' + dashRec.pid);
  }

  // --- 2. Per-swarm dispatch reconcile + coordinator health ---
  for (const swarmId of listSwarmIds(registryRoot)) {
    let ws;
    try {
      ws = ctx.buildWorkspace(registryRoot, swarmId);
    } catch {
      continue;
    }
    if (!fs.existsSync(ws.root)) continue;

    // Dispatch auto-heal
    let changes = [];
    try {
      changes = ctx.reconcileDeadDispatches(ws, { dryRun }) || [];
    } catch (err) {
      act('dispatch-reconcile-error', { swarmId, error: String(err.message || err) });
    }
    for (const c of changes) {
      act('dispatch-reconcile', {
        swarmId,
        id: c.id,
        from: c.from,
        to: c.to,
        reason: c.reason,
        agentLabel: c.agentLabel,
      });
      // 1.0.3: optionally capture trace on failed dispatch with sessionId (diagnostics)
      if (c.to === 'failed' && c.sessionId && !dryRun) {
        try {
          const out = path.join(ws.root, `trace-${c.id}-${c.sessionId}.tar.gz`);
          spawnSync('grok', ['trace', c.sessionId, '--local', '-o', out], { timeout: 5000 });
          act('dispatch-trace', { swarmId, dispatchId: c.id, sessionId: c.sessionId, trace: out });
        } catch {}
      }
    }

    // Dashboard lag / board-deception fixes (2026-07-30):
    // 1) assigned/open/planning + live running dispatch → building
    // 2) review/building + no live dispatch + worktree branch already on HEAD → done
    //    (coordinator merged then stalled without task update → UI "Idle" + 0% + Review forever)
    try {
      const boardForPromote = ctx.readState(ws);
      const tasksForPromote = (boardForPromote && boardForPromote.tasks) || [];
      const allDisp =
        typeof ctx.readDispatches === 'function' ? ctx.readDispatches(ws) || [] : [];
      const runningForPromote = allDisp.filter((r) => r.status === 'running');
      const runningByTask = new Map();
      for (const r of runningForPromote) {
        if (r.taskId && !runningByTask.has(r.taskId)) runningByTask.set(r.taskId, r);
      }
      const doneDispByTask = new Map();
      for (const r of allDisp) {
        if (!r.taskId) continue;
        if (r.status !== 'done') continue;
        const list = doneDispByTask.get(r.taskId) || [];
        list.push(r);
        doneDispByTask.set(r.taskId, list);
      }

      function taskUpdate(taskId, status, note) {
        execFileSync(
          process.execPath,
          [swarmCjs, 'task', 'update', '--id', taskId, '--status', status, '--note', note],
          {
            cwd: repo,
            env: {
              ...process.env,
              SWARM_AGENT_NAME: 'Healer',
              SWARM_ID: swarmId,
            },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
      }

      function branchMergedIntoHead(branchOrPath) {
        if (!branchOrPath) return false;
        // Prefer branch name swarm/<wt>; also accept worktree path basename
        const candidates = [];
        if (String(branchOrPath).startsWith('swarm/')) candidates.push(branchOrPath);
        else {
          const base = path.basename(String(branchOrPath));
          candidates.push('swarm/' + base);
          if (base.startsWith('wt-')) candidates.push('swarm/' + base);
          candidates.push(branchOrPath);
        }
        for (const ref of candidates) {
          const r = spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', ref, 'HEAD'], {
            encoding: 'utf8',
          });
          if (r.status === 0) return true;
        }
        // Fallback: recent merge commit subject mentions task id or worktree name
        return false;
      }

      for (const t of tasksForPromote) {
        const st = String(t.status || '');
        if (st === 'open' || st === 'assigned' || st === 'planning') {
          const run = runningByTask.get(t.id);
          if (!run) continue;
          act('task-promote-building', {
            swarmId,
            taskId: t.id,
            from: st,
            dispatchId: run.id,
            agentLabel: run.agentLabel,
          });
          if (!dryRun) {
            try {
              taskUpdate(t.id, 'building', 'heal: dispatch live → building (dashboard lag)');
            } catch (err) {
              act('task-promote-building-failed', {
                swarmId,
                taskId: t.id,
                error: String(err.message || err),
              });
            }
          }
          continue;
        }

        // review/building stuck after merge
        if (st !== 'review' && st !== 'building') continue;
        if (runningByTask.has(t.id)) continue;
        const dones = doneDispByTask.get(t.id) || [];
        if (dones.length === 0) continue;
        // Prefer newest done dispatch with worktree info
        const newest = dones.slice().sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))[0];
        const wtRef = newest.worktree || newest.worktreePath || '';
        const merged = branchMergedIntoHead(wtRef);
        // Also: log message / note containing "merged" on task notes
        const notes = Array.isArray(t.notes) ? t.notes : [];
        const noteSaysMerged = notes.some((n) => /merged/i.test(String((n && n.text) || n || '')));
        if (!merged && !noteSaysMerged) {
          // Last resort: git log --grep task id on last 30 commits
          const grepped = spawnSync(
            'git',
            ['-C', repo, 'log', '-n', '40', '--oneline', '--grep', t.id],
            { encoding: 'utf8' },
          );
          if (!(grepped.status === 0 && grepped.stdout && grepped.stdout.trim())) continue;
        }
        act('task-promote-done-merged', {
          swarmId,
          taskId: t.id,
          from: st,
          worktree: wtRef,
          dispatchId: newest.id,
        });
        if (!dryRun) {
          try {
            taskUpdate(
              t.id,
              'done',
              'heal: branch already on HEAD / merge commit present → done (unstick review lag)',
            );
          } catch (err) {
            act('task-promote-done-failed', {
              swarmId,
              taskId: t.id,
              error: String(err.message || err),
            });
          }
        }
      }

      // If every non-cancelled task is done, complete active goals (board progress 100%)
      const boardAfter = ctx.readState(ws);
      const remaining = (boardAfter.tasks || []).filter(
        (t) => !['done', 'cancelled'].includes(String(t.status || '')),
      );
      if (remaining.length === 0) {
        for (const g of boardAfter.goals || []) {
          if (String(g.status || '') === 'active' || String(g.status || '') === 'blocked') {
            act('goal-complete-all-tasks-done', { swarmId, goalId: g.id });
            if (!dryRun) {
              try {
                // --no-cleanup: visual force-pass / board reads still need the workspace
                // this tick. Leftover cleanup runs at end of heal (below).
                execFileSync(
                  process.execPath,
                  [
                    swarmCjs,
                    'goal',
                    'update',
                    '--id',
                    g.id,
                    '--status',
                    'completed',
                    '--no-cleanup',
                  ],
                  {
                    cwd: repo,
                    env: { ...process.env, SWARM_AGENT_NAME: 'Healer', SWARM_ID: swarmId },
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'pipe'],
                    timeout: 60000,
                  },
                );
                act('goal-complete-all-tasks-done-ok', { swarmId, goalId: g.id });
              } catch (err) {
                act('goal-complete-failed', { swarmId, goalId: g.id, error: String(err.message || err) });
              }
            }
          }
        }
      }
    } catch (err) {
      act('task-promote-scan-error', { swarmId, error: String(err.message || err) });
    }

    let board;
    try {
      board = ctx.readState(ws);
    } catch {
      board = null;
    }
    const openTasks = (board && board.tasks) || [];
    const hasOpen = openTasks.some((t) => !['done', 'cancelled'].includes(t.status));

    // --- D1: cancelled tasks with missing dependsOn IDs → scrub to [] (always) ---
    scrubCancelledBrokenDeps(ctx, repo, ws, board, dryRun, act, swarmCjs);

    // --- Visual: ALWAYS evaluate (A6) — do not require open tasks ---
    const reviews = findReviewResults(ws.root);
    if (reviews.length) {
      const latest = reviews[0];
      const status = String(latest.result.status || '').toUpperCase();
      const gatePath = path.join(ws.root, 'review-artifacts', 'review_result.json');
      const gateExists = fs.existsSync(gatePath);

      // Promote PASS into canonical gate path
      if (status === 'PASS' && !gateExists && !dryRun) {
        try {
          fs.mkdirSync(path.dirname(gatePath), { recursive: true });
          fs.copyFileSync(latest.path, gatePath);
          act('visual-promote-pass', { swarmId, from: latest.path });
        } catch (err) {
          act('visual-promote-failed', { swarmId, error: String(err.message || err) });
        }
      }

      // Optional force-pass only when visual-policy says eligible (never product REVISE high)
      // A6: openTasks may be empty — eligibility uses DC + review_result fields only
      if (autoVisualPass) {
        const classified = classifyReviewResult(latest.result);
        const doubleCheckComplete =
          String(latest.result.doubleCheck || '').toLowerCase() === 'complete' ||
          latest.result.doubleCheck === true ||
          hasHardDoubleCheck(repo, ws.root);
        const codeGatesGreen = inferCodeGatesGreen(latest.result, openTasks);
        const visualAgeMs = now - (latest.mtime || now);
        const eligibility = isForcePassEligible({
          result: latest.result,
          codeGatesGreen,
          doubleCheckComplete,
          visualAgeMs,
        });
        const edgeId = !hasOpen ? 'A6' : undefined;
        act('visual-force-pass-eval', {
          swarmId,
          kind: classified.kind,
          eligible: eligibility.ok,
          reason: eligibility.reason,
          edgeId,
          healAction: !hasOpen ? (EDGES.A6 && EDGES.A6.healAction) : undefined,
        });
        if (eligibility.ok && !dryRun) {
          try {
            writeJsonPretty(gatePath, {
              status: 'PASS',
              summary:
                'healer force-pass: ' +
                eligibility.reason +
                ' — ' +
                String(latest.result.summary || '').slice(0, 200),
              findings: latest.result.findings || [],
              routesChecked: latest.result.routesChecked || [],
              doubleCheck: latest.result.doubleCheck || 'complete',
              healer: true,
              originalStatus: latest.result.status,
              originalPath: latest.path,
              healedAt: new Date().toISOString(),
              edgeId: edgeId || undefined,
            });
            act('visual-auth-pass', {
              swarmId,
              gatePath,
              reason: eligibility.reason,
              edgeId,
            });
          } catch (err) {
            act('visual-auth-pass-failed', {
              swarmId,
              error: String(err.message || err),
            });
          }
        } else if (!eligibility.ok) {
          if (status === 'BLOCKED') {
            act('visual-blocked', {
              swarmId,
              authOnly: isAuthOnlyBlocked(latest.result),
              path: latest.path,
              reason: eligibility.reason,
            });
          } else if (status === 'REVISE') {
            act('visual-revise', {
              swarmId,
              path: latest.path,
              reason: eligibility.reason,
              productHigh: classified.productHigh,
            });
          }
        }
      } else if (status === 'BLOCKED') {
        act('visual-blocked', {
          swarmId,
          authOnly: isAuthOnlyBlocked(latest.result),
          path: latest.path,
        });
      } else if (status === 'REVISE') {
        act('visual-revise', { swarmId, path: latest.path });
      }
    } else {
      // C5: no review_result + dead visual + age >12m + hard gates+DC
      tryVisualNoResultAgePass({
        ws,
        repo,
        openTasks,
        reviews,
        autoVisualPass,
        dryRun,
        now,
        act,
      });
    }

    // Coordinator liveness / stall restart only when board still has open work
    if (!hasOpen) continue;

    // Operator hard pause (pause.json without noKill): coordinator was stopped on purpose.
    // Restarting it would run `swarm resume` from its startup step and silently un-pause.
    const pauseRec = readJsonSafe(path.join(ws.root, 'pause.json'), null);
    if (pauseRec && !pauseRec.noKill) {
      act('coordinator-paused-skip', { swarmId, pausedAt: pauseRec.pausedAt, noKill: false });
      continue;
    }

    const coordFile = path.join(ws.root, 'coordinator.pid');
    const coord = readJsonSafe(coordFile, null);
    const coordAlive = coord && isAlive(coord.pid);
    if (!coordAlive) {
      // A2: dead/missing coordinator mid-mission → restart with reason max-turns-or-exit
      act(coord && coord.pid ? 'coordinator-dead' : 'coordinator-missing', {
        swarmId,
        pid: coord && coord.pid,
        edgeId: 'A2',
        reason: 'max-turns-or-exit',
        healAction: EDGES.A2 && EDGES.A2.healAction,
      });
      if (restartCoordinators && !dryRun) {
        try {
          const args = [
            swarmCjs,
            'coordinator',
            'start',
            '--daemon',
            '--swarm',
            swarmId,
            '--cwd',
            repo,
          ];
          if (coord && coord.pid) args.push('--resume');
          execFileSync(process.execPath, args, {
            cwd: repo,
            env: { ...process.env, SWARM_AGENT_NAME: 'Healer', SWARM_ID: swarmId },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 60_000,
          });
          act(coord && coord.pid ? 'coordinator-restarted' : 'coordinator-started', {
            swarmId,
            edgeId: 'A2',
            reason: 'max-turns-or-exit',
            healAction: EDGES.A2 && EDGES.A2.healAction,
          });
        } catch (err) {
          act('coordinator-restart-failed', {
            swarmId,
            edgeId: 'A2',
            reason: 'max-turns-or-exit',
            error: String((err.stderr || err.message || err)).slice(0, 400),
          });
        }
      }
    } else {
      // A1: coord alive, log quiet >180s, builders terminal, open tasks only review
      // → coordinator-stall-restart + start --resume (rate-limit 1/10m)
      const clog = path.join(ws.root, 'coordinator.log');
      let logAge = null;
      try {
        if (fs.existsSync(clog)) logAge = now - fs.statSync(clog).mtimeMs;
      } catch {
        /* ignore */
      }
      const dispatches = readDispatchesLocal(ws);
      const builderRuns = dispatches.filter((d) => isBuilderAgentLabel(d.agentLabel));
      const buildersTerminal =
        builderRuns.length === 0 ||
        builderRuns.every((d) => {
          if (d.status === 'running' && isAlive(d.pid)) return false;
          return true;
        });
      const nonTerminal = openTasks.filter((t) => !['done', 'cancelled'].includes(String(t.status || '')));
      const onlyReview =
        nonTerminal.length > 0 && nonTerminal.every((t) => String(t.status || '') === 'review');

      if (onlyReview && buildersTerminal && logAge != null && logAge > 180_000) {
        const allowed = canStallRestart(healDir, swarmId, now);
        act('coordinator-log-stall', {
          swarmId,
          edgeId: 'A1',
          logAgeSec: Math.round(logAge / 1000),
          rateLimited: !allowed,
          hint: allowed
            ? 'coord stalled after builders done — healer will restart --resume'
            : 'stall restart rate-limited (1/10m)',
        });
        if (allowed && restartCoordinators) {
          act('coordinator-stall-restart', {
            swarmId,
            edgeId: 'A1',
            logAgeSec: Math.round(logAge / 1000),
            healAction: EDGES.A1 && EDGES.A1.healAction,
          });
          if (!dryRun) {
            try {
              const args = [
                swarmCjs,
                'coordinator',
                'start',
                '--daemon',
                '--swarm',
                swarmId,
                '--cwd',
                repo,
                '--resume',
              ];
              execFileSync(process.execPath, args, {
                cwd: repo,
                env: { ...process.env, SWARM_AGENT_NAME: 'Healer', SWARM_ID: swarmId },
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 60_000,
              });
              markStallRestart(healDir, swarmId, now);
              act('coordinator-restarted', {
                swarmId,
                edgeId: 'A1',
                reason: 'stall',
                healAction: EDGES.A1 && EDGES.A1.healAction,
              });
            } catch (err) {
              act('coordinator-restart-failed', {
                swarmId,
                edgeId: 'A1',
                reason: 'stall',
                error: String((err.stderr || err.message || err)).slice(0, 400),
              });
            }
          }
        }
      } else if (
        openTasks.some((t) => t.status === 'review' || t.status === 'building') &&
        logAge != null &&
        logAge > 180_000
      ) {
        // Detect-only when not A1-eligible (e.g. still building)
        act('coordinator-log-stall', {
          swarmId,
          logAgeSec: Math.round(logAge / 1000),
          hint: 'coord thinking/stuck — Mode B unstick or coordinator stop+start --resume',
        });
      }
    }

    // --- End of swarm tick: cleanup leftover worktrees when goal is done ---
    // Runs AFTER visual force-pass so A6 still has a workspace this tick.
    // Coordinator also auto-cleans via `goal update --status completed` (no --no-cleanup).
    try {
      if (process.env.GROK_SWARM_AUTO_CLEANUP === '0' || dryRun) {
        /* skip */
      } else if (fs.existsSync(path.join(ws.root, 'mega-context.json'))) {
        /* mega: meta cleanup only */
      } else {
        let boardFinal = null;
        try {
          boardFinal = ctx.readState(ws);
        } catch {
          boardFinal = null;
        }
        if (boardFinal) {
          const tasksF = boardFinal.tasks || [];
          const allDone =
            tasksF.length > 0 &&
            tasksF.every((t) => ['done', 'cancelled', 'blocked'].includes(String(t.status || '')));
          const goalDone = (boardFinal.goals || []).some(
            (g) => String(g.status || '') === 'completed',
          );
          if (allDone && goalDone) {
            const base =
              process.env.GROK_WORKTREES_ROOT ||
              path.join(process.env.HOME || '', '.grok', 'worktrees');
            const wtRoot = path.join(base, 'repos-' + path.basename(repo));
            let leftovers = 0;
            let leftoverBranches = 0;
            if (fs.existsSync(wtRoot)) {
              leftovers = fs
                .readdirSync(wtRoot)
                .filter((n) => n.startsWith('wt-') || n.startsWith('scout-') || n.startsWith('wt-scout-'))
                .length;
            }
            // Count only branches tied to this swarm (dispatch records + swarmId) — not every swarm/wt-* on host
            try {
              const dispDir = (ws && (ws.dispatches || ws.dispatchesDir)) || path.join(ws.root, 'dispatches');
              const tied = new Set();
              if (fs.existsSync(dispDir)) {
                for (const f of fs.readdirSync(dispDir).filter((x) => x.endsWith('.json'))) {
                  try {
                    const rec = JSON.parse(fs.readFileSync(path.join(dispDir, f), 'utf8'));
                    if (rec.worktree) {
                      tied.add('swarm/' + rec.worktree);
                      tied.add(rec.worktree);
                    }
                    if (rec.branch) tied.add(rec.branch.replace(/^refs\/heads\//, ''));
                  } catch {}
                }
              }
              const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'swarm/wt-*'], { encoding: 'utf8' })
                .split('\n')
                .map((l) => l.replace(/^\*?\s+/, '').trim())
                .filter(Boolean);
              for (const b of branches) {
                if (b.includes(swarmId) || tied.has(b)) leftoverBranches++;
              }
            } catch { leftoverBranches = 0; }
            const totalLeftovers = leftovers + leftoverBranches;
            if (totalLeftovers > 0) {
              act('auto-cleanup-leftover-worktrees', { swarmId, leftovers, leftoverBranches, totalLeftovers });
              try {
                execFileSync(
                  process.execPath,
                  [swarmCjs, 'cleanup', '--swarm', swarmId, '--repo', repo],
                  {
                    cwd: repo,
                    env: { ...process.env, SWARM_AGENT_NAME: 'Healer', SWARM_ID: swarmId },
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'pipe'],
                    timeout: 120000,
                  },
                );
                act('auto-cleanup-leftover-ok', { swarmId });
              } catch (err) {
                act('auto-cleanup-leftover-failed', {
                  swarmId,
                  error: String(err.message || err).slice(0, 400),
                });
              }
            }
          }
        }
      }
    } catch (err) {
      act('auto-cleanup-scan-error', { swarmId, error: String(err.message || err).slice(0, 200) });
    }
  }

  // --- 3. Mega daemon + per-sub coordinator via mega tick soft ---
  for (const mega of listActiveMegas(registryRoot)) {
    const pidFile = path.join(mega.dir, 'daemon.pid');
    const drec = readJsonSafe(pidFile, null);
    if (drec && drec.pid && !isAlive(drec.pid)) {
      act('mega-daemon-dead', { megaId: mega.megaId, pid: drec.pid });
      if (restartMega && !dryRun) {
        try {
          execFileSync(
            process.execPath,
            [
              swarmCjs,
              'mega',
              'run',
              '--id',
              mega.megaId,
              '--repo',
              repo,
              '--daemon',
              '--interval',
              '30',
              '--auto-merge',
            ],
            {
              cwd: repo,
              env: { ...process.env, SWARM_AGENT_NAME: 'Healer' },
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );
          act('mega-daemon-restarted', { megaId: mega.megaId });
        } catch (err) {
          act('mega-daemon-restart-failed', {
            megaId: mega.megaId,
            error: String(err.message || err).slice(0, 400),
          });
        }
      }
    } else if (!drec || !isAlive(drec && drec.pid)) {
      act('mega-daemon-missing', { megaId: mega.megaId, status: mega.state.status });
    }

    // Running subswarms without alive coordinator — already handled per-swarm above
    // if swarmId matches. Also note capacity.
    const subs = mega.state.subswarms || {};
    let running = 0;
    for (const [name, sub] of Object.entries(subs)) {
      if (sub.status === 'running') running++;
      if (sub.status === 'running' && sub.swarmId) {
        const cf = path.join(registryRoot, 'swarms', sub.swarmId, 'coordinator.pid');
        const c = readJsonSafe(cf, null);
        if (!c || !isAlive(c.pid)) {
          // already acted in per-swarm loop if swarm dir exists
          act('mega-sub-coord-gap', { megaId: mega.megaId, sub: name, swarmId: sub.swarmId });
        }
      }
    }
    notes.push('mega ' + mega.megaId + ' running_subs=' + running);
  }

  const report = {
    ok: true,
    at: now,
    iso: new Date(now).toISOString(),
    repo,
    dryRun,
    actions,
    notes,
    summary: {
      actionCount: actions.length,
      healed: actions.filter((a) =>
        /reconcile|restarted|started|promote|auth-pass|dep-scrub|no-result-age-pass$|stall-restart/.test(
          a.type,
        ),
      ).length,
      warnings: actions.filter((a) =>
        /dead|missing|stall|blocked|revise|failed|gap|no-result$/.test(a.type),
      ).length,
    },
  };

  // Journal
  if (!dryRun) {
    try {
      fs.mkdirSync(healDir, { recursive: true });
      writeJsonPretty(path.join(healDir, 'last.json'), report);
      appendLog(
        path.join(healDir, 'heal.log'),
        'tick actions=' +
          actions.length +
          ' healed=' +
          report.summary.healed +
          ' warn=' +
          report.summary.warnings +
          (actions.length
            ? ' :: ' + actions.map((a) => a.type + (a.swarmId ? '@' + a.swarmId : '')).join(', ')
            : ''),
      );
    } catch {
      /* ignore */
    }
  }

  return report;
}

function healCommand(ctx, argv) {
  const args = ctx.parseArgs(argv);
  const sub = args._[0];
  const repo =
    (args.repo && args.repo !== 'true' ? path.resolve(args.repo) : null) ||
    (args.cwd && args.cwd !== 'true' ? path.resolve(args.cwd) : null) ||
    process.cwd();
  const registryRoot = path.join(repo, '.grok-swarm');
  if (!fs.existsSync(registryRoot)) {
    ctx.die('No .grok-swarm in ' + repo + ' — pass --repo /path/to/repo');
  }

  const healDir = path.join(registryRoot, 'heal');
  const pidFile = path.join(healDir, 'healer.pid');
  const logFile = path.join(healDir, 'healer-daemon.log');

  if (sub === 'stop' || args.stop === 'true') {
    const rec = readJsonSafe(pidFile, null);
    if (rec && isAlive(rec.pid)) {
      try {
        process.kill(rec.pid, 'SIGTERM');
      } catch {
        /* ignore */
      }
      console.log('Stopped healer pid ' + rec.pid);
    } else {
      console.log('No running healer daemon');
    }
    try {
      fs.unlinkSync(pidFile);
    } catch {
      /* ignore */
    }
    return;
  }

  if (sub === 'status' || args.status === 'true') {
    const rec = readJsonSafe(pidFile, null);
    const alive = rec && isAlive(rec.pid);
    const last = readJsonSafe(path.join(healDir, 'last.json'), null);
    if (args.json === 'true') {
      console.log(JSON.stringify({ running: !!alive, rec, last }, null, 2));
    } else {
      console.log(
        alive
          ? 'Healer running: pid ' + rec.pid + ' interval=' + (rec.intervalSec || '?') + 's log=' + (rec.logFile || logFile)
          : 'Healer not running',
      );
      if (last) {
        console.log(
          'Last tick: ' +
            (last.iso || '?') +
            ' actions=' +
            (last.summary && last.summary.actionCount) +
            ' healed=' +
            (last.summary && last.summary.healed),
        );
      }
    }
    process.exitCode = alive ? 0 : 1;
    return;
  }

  if (sub === 'doctor' || args.doctor === 'true') {
    // Dry report only
    const report = healTick(ctx, repo, {
      dryRun: true,
      restartDaemons: false,
      restartCoordinators: false,
      restartMega: false,
      autoVisualPass: false,
    });
    // Re-run with real reconcile dry via same path
    if (args.json === 'true') {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log('Healer doctor (dry) — ' + repo);
      console.log('  would_act: ' + report.actions.length);
      for (const a of report.actions.slice(0, 40)) {
        console.log(
          '  - ' +
            a.type +
            (a.swarmId ? ' ' + a.swarmId : '') +
            (a.megaId ? ' mega=' + a.megaId : '') +
            (a.reason ? ' (' + a.reason + ')' : '') +
            (a.hint ? ' — ' + a.hint : ''),
        );
      }
      if (report.actions.length > 40) console.log('  … +' + (report.actions.length - 40) + ' more');
      for (const n of report.notes || []) console.log('  note: ' + n);
    }
    // doctor is diagnostic: exit 0 unless --strict (CI gate)
    if (args.strict === 'true') {
      process.exitCode = report.actions.some((a) => /dead|missing|stall|failed|gap/.test(a.type))
        ? 1
        : 0;
    } else {
      process.exitCode = 0;
    }
    return;
  }

  const tickOpts = {
    dryRun: args['dry-run'] === 'true',
    restartDaemons: args['no-restart-daemons'] !== 'true',
    restartCoordinators: args['no-restart-coordinators'] !== 'true',
    restartMega: args['restart-mega'] === 'true',
    // Default false: interactive heal never force-passes; mega FE daemons should pass --auto-visual-pass
    autoVisualPass: args['auto-visual-pass'] === 'true',
  };

  // Daemon mode
  if (args.daemon === 'true' || sub === 'start') {
    const existing = readJsonSafe(pidFile, null);
    if (existing && isAlive(existing.pid)) {
      console.log('Healer already running: pid ' + existing.pid);
      return;
    }
    const intervalSec = Math.max(10, Number(args.interval) || 30);
    if (args['_daemon-child'] === 'true') {
      // Child loop
      writeJsonPretty(pidFile, {
        pid: process.pid,
        repo,
        intervalSec,
        logFile,
        startedAt: Date.now(),
        opts: tickOpts,
      });
      const runOnce = () => {
        try {
          const report = healTick(ctx, repo, tickOpts);
          appendLog(
            logFile,
            'tick actions=' +
              report.actions.length +
              ' healed=' +
              report.summary.healed +
              ' warn=' +
              report.summary.warnings,
          );
        } catch (err) {
          appendLog(logFile, 'tick error: ' + (err && err.stack ? err.stack : err));
        }
      };
      runOnce();
      setInterval(runOnce, intervalSec * 1000);
      // Keep process alive
      process.on('SIGTERM', () => {
        try {
          fs.unlinkSync(pidFile);
        } catch {
          /* ignore */
        }
        process.exit(0);
      });
      return;
    }

    fs.mkdirSync(healDir, { recursive: true });
    const childArgs = [
      path.join(ctx.skillRootDir(), 'bin', 'swarm.cjs'),
      'heal',
      'start',
      '--daemon',
      '--_daemon-child',
      '--repo',
      repo,
      '--interval',
      String(intervalSec),
    ];
    if (tickOpts.autoVisualPass) childArgs.push('--auto-visual-pass');
    if (tickOpts.restartMega) childArgs.push('--restart-mega');
    if (!tickOpts.restartDaemons) childArgs.push('--no-restart-daemons');
    if (!tickOpts.restartCoordinators) childArgs.push('--no-restart-coordinators');
    if (tickOpts.dryRun) childArgs.push('--dry-run');

    const logFd = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, childArgs, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, SWARM_AGENT_NAME: 'Healer' },
      cwd: repo,
    });
    child.unref();
    fs.closeSync(logFd);
    // pidfile written by child; wait briefly
    let wrote = null;
    for (let i = 0; i < 40; i++) {
      try {
        const rec = readJsonSafe(pidFile, null);
        if (rec && rec.pid) {
          wrote = rec;
          break;
        }
      } catch {
        /* ignore */
      }
      const end = Date.now() + 50;
      while (Date.now() < end) {
        /* spin */
      }
    }
    console.log(
      'Healer daemon started: pid ' +
        (wrote && wrote.pid ? wrote.pid : child.pid) +
        ' interval=' +
        intervalSec +
        's log=' +
        logFile,
    );
    console.log('Stop:   swarm heal stop --repo ' + repo);
    console.log('Status: swarm heal status --repo ' + repo);
    console.log('Doctor: swarm heal doctor --repo ' + repo);
    return;
  }

  // One-shot tick (default)
  const report = healTick(ctx, repo, tickOpts);
  if (args.json === 'true') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      'Healer tick' +
        (tickOpts.dryRun ? ' (dry-run)' : '') +
        ': actions=' +
        report.actions.length +
        ' healed=' +
        report.summary.healed +
        ' warnings=' +
        report.summary.warnings,
    );
    for (const a of report.actions) {
      console.log(
        '  - ' +
          a.type +
          (a.swarmId ? ' @' + a.swarmId : '') +
          (a.id ? ' ' + a.id : '') +
          (a.to ? ' → ' + a.to : '') +
          (a.reason ? ' (' + a.reason + ')' : '') +
          (a.hint ? ' — ' + a.hint : ''),
      );
    }
    if (!report.actions.length) console.log('  (nothing to heal)');
  }
  process.exitCode = report.actions.some((a) => /restart-failed|failed/.test(a.type)) ? 1 : 0;
}

module.exports = {
  healTick,
  healCommand,
  findReviewResults,
  isAuthOnlyBlocked,
  isForcePassEligible,
  classifyReviewResult,
  inferCodeGatesGreen,
  listSwarmIds,
  listActiveMegas,
  readDispatchesLocal,
  hasHardDoubleCheck,
  hasHardCodeGatesGreen,
  STALL_RESTART_COOLDOWN_MS,
};
