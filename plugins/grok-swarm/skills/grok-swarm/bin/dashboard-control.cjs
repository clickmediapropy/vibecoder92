'use strict';
// dashboard-control.cjs — operator control plane for the Mission Control dashboard.
// POST /api/control | /api/mail | /api/task, GET /api/mail. Every mutation shells out
// to swarm.cjs as SWARM_AGENT_NAME=Operator (same pattern as heal.cjs coordinator restart).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MAX_BODY = 64 * 1024;

function runSwarm(ctx, swarmId, args) {
  const cmd = 'swarm ' + args.join(' ');
  try {
    const stdout = execFileSync(process.execPath, [ctx.swarmCjs, ...args, '--swarm', swarmId, '--cwd', ctx.repoRoot], {
      cwd: ctx.repoRoot,
      env: { ...process.env, SWARM_AGENT_NAME: 'Operator', SWARM_ID: swarmId },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return { cmd, exitCode: 0, stdout, stderr: '' };
  } catch (err) {
    return { cmd, exitCode: err.status == null ? 1 : err.status, stdout: err.stdout || '', stderr: err.stderr || String(err.message || err) };
  }
}

function ensureOperatorAgent(ctx, ws, swarmId) {
  if (ctx.readAgents(ws).some((a) => a && a.label === 'Operator')) return null;
  return runSwarm(ctx, swarmId, ['agent', 'register', '--label', 'Operator', '--role', 'coordinator']);
}

function readTranscript(ws, limit) {
  if (!fs.existsSync(ws.transcript)) return [];
  const out = [];
  for (const f of fs.readdirSync(ws.transcript)) {
    if (!f.endsWith('.json')) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(ws.transcript, f), 'utf8'));
      const party = (x) => x === 'Operator' || x === 'Coordinator';
      const relevant = (party(m.from) && (party(m.to) || m.to === '@all')) ||
        m.type === 'escalation' || m.type === 'swarm_complete';
      if (relevant) out.push({ id: m.id, from: m.from, to: m.to, type: m.type, body: m.body, timestamp: m.timestamp });
    } catch { /* skip corrupt */ }
  }
  out.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  return out.slice(-limit);
}

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function finish(res, steps) {
  const failed = steps.find((s) => s.exitCode !== 0);
  send(res, 200, {
    ok: !failed,
    exitCode: failed ? failed.exitCode : 0,
    stdout: steps.map((s) => s.stdout).join(''),
    stderr: steps.map((s) => s.stderr).join(''),
    steps: steps.map((s) => ({ cmd: s.cmd, exitCode: s.exitCode })),
  });
}

function control(ctx, ws, swarmId, action, res) {
  const steps = [];
  const pause = fs.existsSync(ws.pauseFile) ? JSON.parse(fs.readFileSync(ws.pauseFile, 'utf8')) : null;
  if (action === 'hold') {
    steps.push(runSwarm(ctx, swarmId, ['pause', '--no-kill', '--reason', 'operator hold']));
  } else if (action === 'pause') {
    // hold → pause: lift the hold first so pauseOneSwarm does not refuse "already paused".
    if (pause && pause.noKill) steps.push(runSwarm(ctx, swarmId, ['resume']));
    steps.push(runSwarm(ctx, swarmId, ['pause', '--reason', 'operator pause']));
    steps.push(runSwarm(ctx, swarmId, ['coordinator', 'stop']));
  } else if (action === 'resume') {
    steps.push(runSwarm(ctx, swarmId, ['resume']));
    if (!ctx.readCoordinatorPid(ctx.registryRoot, swarmId)) {
      steps.push(runSwarm(ctx, swarmId, ['coordinator', 'start', '--resume', '--daemon']));
    }
    const healPid = path.join(ctx.registryRoot, 'heal', 'healer.pid');
    let healAlive = false;
    try { const rec = JSON.parse(fs.readFileSync(healPid, 'utf8')); process.kill(rec.pid, 0); healAlive = true; } catch { /* dead */ }
    if (!healAlive) steps.push(runSwarm(ctx, swarmId, ['heal', '--daemon']));
  } else {
    send(res, 400, { ok: false, error: 'Unknown action: ' + action + ' (hold|pause|resume)' });
    return;
  }
  finish(res, steps);
}

/**
 * @returns {boolean} true if the request was handled.
 */
function handleControlRequest(ctx, req, res, body) {
  const parsed = new URL(req.url || '/', 'http://127.0.0.1');
  const p = parsed.pathname;
  const isCtl = p === '/api/control' || p === '/api/mail' || p === '/api/task';
  if (!isCtl) return false;

  let data = {};
  if (req.method === 'POST') {
    if (body.length > MAX_BODY) { send(res, 413, { ok: false, error: 'body too large' }); return true; }
    try { data = body ? JSON.parse(body) : {}; } catch { send(res, 400, { ok: false, error: 'invalid JSON' }); return true; }
  }

  let swarmId, ws;
  try {
    const registry = ctx.ensureRegistry(ctx.registryRoot);
    swarmId = ctx.resolveSwarmIdHttp(registry, data.swarm || parsed.searchParams.get('swarm'));
    ws = ctx.buildWorkspace(ctx.registryRoot, swarmId);
  } catch (err) {
    send(res, 400, { ok: false, error: String(err && err.message || err) });
    return true;
  }

  if (p === '/api/control' && req.method === 'POST') {
    control(ctx, ws, swarmId, String(data.action || ''), res);
    return true;
  }

  if (p === '/api/mail' && req.method === 'GET') {
    const limit = Math.max(1, Math.min(500, Number(parsed.searchParams.get('limit')) || 100));
    let paused = null;
    try { paused = fs.existsSync(ws.pauseFile) ? JSON.parse(fs.readFileSync(ws.pauseFile, 'utf8')) : null; } catch { paused = null; }
    send(res, 200, {
      messages: readTranscript(ws, limit),
      coordinatorAlive: !!ctx.readCoordinatorPid(ctx.registryRoot, swarmId),
      paused,
    });
    return true;
  }

  if (p === '/api/mail' && req.method === 'POST') {
    const text = String(data.body || '').trim();
    if (!text) { send(res, 400, { ok: false, error: 'body required' }); return true; }
    const steps = [];
    const reg = ensureOperatorAgent(ctx, ws, swarmId);
    if (reg) steps.push(reg);
    steps.push(runSwarm(ctx, swarmId, ['mail', 'send', '--to', 'Coordinator', '--type', 'message', '--body', text.slice(0, 8000)]));
    finish(res, steps);
    return true;
  }

  if (p === '/api/task' && req.method === 'POST') {
    const title = String(data.title || '').trim();
    if (!title) { send(res, 400, { ok: false, error: 'title required' }); return true; }
    const args = ['task', 'create', '--title', title];
    if (data.files) args.push('--files', String(data.files).trim());
    if (data.acceptance) args.push('--acceptance', String(data.acceptance).trim());
    if (data.owner) args.push('--owner', String(data.owner).trim());
    const steps = [runSwarm(ctx, swarmId, args)];
    if (steps[0].exitCode === 0) steps.push(runSwarm(ctx, swarmId, ['board', '--sync']));
    finish(res, steps);
    return true;
  }

  send(res, 405, { ok: false, error: 'method not allowed' });
  return true;
}

module.exports = { handleControlRequest, readTranscript };
