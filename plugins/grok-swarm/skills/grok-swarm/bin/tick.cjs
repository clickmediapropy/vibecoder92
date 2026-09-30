'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const { buildWorkerResumeCommand } = require('./resume-cmd.cjs');

const TERMINAL = new Set(['done', 'blocked', 'cancelled']);

function depsAllDone(task, byId) {
  for (const dep of task.dependsOn || []) {
    const d = byId.get(dep);
    if (!d || d.status !== 'done') return false;
  }
  return true;
}

function slug(id) {
  return String(id || 'task').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function defaultPrintOnly(spec) {
  const script = path.join(__dirname, 'dispatch-grok.sh');
  const promptFile = spec.promptFile || path.join(__dirname, '..', 'templates', 'builder-prompt.md');
  const flags = [
    '--mode', spec.mode || 'new',
    '--agent', spec.agent,
    '--prompt-file', promptFile,
    '--log', spec.log,
    '--task', spec.taskId,
  ];
  if ((spec.mode || 'new') === 'new') {
    flags.push('--repo', spec.repo, '--worktree', spec.worktree, '--base', spec.base || 'HEAD');
  } else {
    flags.push('--worktree-path', spec.worktreePath);
  }
  const stdout = execFileSync('bash', [script, '--print-only', ...flags], { encoding: 'utf8' });
  return [script, ...flags].join(' ') + '\n' + stdout;
}

function dispatchNew(task, input, printOnly) {
  const spec = {
    mode: 'new',
    repo: input.repoRoot,
    worktree: 'wt-' + slug(task.id),
    base: 'HEAD',
    agent: task.ownerAgentLabel || 'Builder 1',
    taskId: task.id,
    log: '/tmp/grok-swarm-' + slug(task.id) + '.log',
    promptFile: input.promptTemplate || null,
  };
  let printOnlyArgv = null;
  let error = null;
  try {
    printOnlyArgv = printOnly(spec);
  } catch (err) {
    error = err && err.stderr ? String(err.stderr) : (err && err.message) || String(err);
  }
  return {
    type: 'dispatch',
    mode: 'new',
    taskId: task.id,
    owner: spec.agent,
    worktree: spec.worktree,
    printOnlyArgv,
    error,
  };
}

function dispatchResume(task, latest, input) {
  const promptFile = input.promptTemplate || path.join(__dirname, '..', 'templates', 'builder-prompt.md');
  let printOnlyArgv = null;
  let error = null;
  try {
    if (latest && latest.sessionId && latest.worktreePath) {
      printOnlyArgv = buildWorkerResumeCommand({
        agentLabel: task.ownerAgentLabel || latest.agentLabel || 'Builder 1',
        sessionId: latest.sessionId,
        worktreePath: latest.worktreePath,
        promptFile,
      });
    } else if (latest && latest.worktreePath) {
      printOnlyArgv = defaultPrintOnly({
        mode: 'existing',
        agent: task.ownerAgentLabel || 'Builder 1',
        taskId: task.id,
        worktreePath: latest.worktreePath,
        log: '/tmp/grok-swarm-' + slug(task.id) + '.log',
        promptFile,
      });
    } else {
      error = 'no sessionId or worktreePath on the failed dispatch';
    }
  } catch (err) {
    error = err && err.message ? err.message : String(err);
  }
  return {
    type: 'dispatch',
    mode: 'resume',
    taskId: task.id,
    owner: task.ownerAgentLabel || null,
    sessionId: latest ? latest.sessionId || null : null,
    worktreePath: latest ? latest.worktreePath || null : null,
    printOnlyArgv,
    error,
  };
}

function computeTick(input) {
  const pause = input.pause || null;
  const tasks = input.tasks || [];
  const dispatches = input.dispatches || [];
  const mail = input.mail || [];
  const dcComplete = input.dcComplete || (() => false);
  const printOnly = input.printOnly || defaultPrintOnly;
  const next = [];

  if (pause && !pause.noKill) {
    return { pause: 'hard', next: [{ type: 'hard_pause' }] };
  }

  const hold = !!(pause && pause.noKill);
  if (hold) next.push({ type: 'hold' });

  const unread = mail.filter((entry) => {
    const msg = entry && entry.message ? entry.message : entry;
    return msg && msg.from === 'Operator';
  }).length;
  if (unread) next.push({ type: 'answer_mail', count: unread });

  const byId = new Map(tasks.map((t) => [t.id, t]));

  const ordered = tasks.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const task of ordered) {
    const rows = dispatches
      .filter((d) => d && d.taskId === task.id)
      .slice()
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    if (rows.some((d) => d.status === 'running')) continue;
    const latest = rows.length ? rows[rows.length - 1] : null;
    const fails = rows.filter((d) => d.status === 'failed' || d.status === 'killed').length;
    const dc = !!dcComplete(task.id, latest && latest.worktreePath);

    if (latest && latest.status === 'done' && task.status !== 'done') {
      if (dc) {
        next.push({
          type: 'merge_candidate',
          taskId: task.id,
          worktree: latest.worktree || null,
          worktreePath: latest.worktreePath || null,
          sessionId: latest.sessionId || null,
        });
      } else if (!hold) {
        if (fails >= 3) next.push({ type: 'block', taskId: task.id });
        else {
          next.push({
            type: 'need_double_check',
            taskId: task.id,
            sessionId: latest.sessionId || null,
            worktreePath: latest.worktreePath || null,
          });
        }
      }
      continue;
    }

    if (hold || TERMINAL.has(task.status)) continue;

    if (fails >= 3) {
      next.push({ type: 'block', taskId: task.id });
      continue;
    }

    if (latest && (latest.status === 'failed' || latest.status === 'killed')) {
      next.push(dispatchResume(task, latest, input));
      continue;
    }

    const ready = (task.status === 'open' || task.status === 'assigned') && depsAllDone(task, byId);
    if (ready) next.push(dispatchNew(task, input, printOnly));
  }

  const allTerminal = tasks.length > 0 && tasks.every((t) => TERMINAL.has(t.status));
  if (allTerminal && !pause) next.push({ type: 'complete' });

  return { pause: hold ? 'hold' : null, next };
}

function printHuman(result) {
  if (!result.next.length) {
    console.log('tick: nothing to do');
    return;
  }
  for (const action of result.next) {
    if (action.type === 'dispatch') {
      console.log('dispatch ' + action.mode + ' ' + action.taskId + (action.owner ? ' @' + action.owner : ''));
      if (action.printOnlyArgv) process.stdout.write(action.printOnlyArgv.endsWith('\n') ? action.printOnlyArgv : action.printOnlyArgv + '\n');
      if (action.error) console.log('dispatch error: ' + action.error);
    } else if (action.type === 'answer_mail') {
      console.log('answer_mail count=' + action.count);
    } else if (action.type === 'merge_candidate') {
      console.log('merge_candidate ' + action.taskId + (action.worktreePath ? ' ' + action.worktreePath : ''));
    } else if (action.type === 'need_double_check') {
      console.log('need_double_check ' + action.taskId);
    } else if (action.type === 'block') {
      console.log('block ' + action.taskId);
    } else {
      console.log(action.type);
    }
  }
}

function tickCommand(deps, argv) {
  const args = deps.parseArgs(argv);
  const { doubleCheckComplete } = require('./double-check-gate.cjs');
  const result = computeTick({
    pause: deps.pause,
    tasks: (deps.state && deps.state.tasks) || [],
    dispatches: deps.dispatches || [],
    mail: deps.mail || [],
    repoRoot: deps.repoRoot,
    skillRoot: deps.skillRoot,
    dcComplete: (taskId, wt) => doubleCheckComplete(deps.repoRoot, taskId, { worktreePath: wt || undefined }).ok,
    printOnly: defaultPrintOnly,
  });
  if (args.json === 'true') console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
}

module.exports = { computeTick, tickCommand, defaultPrintOnly };
