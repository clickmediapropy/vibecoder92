#!/usr/bin/env node
'use strict';
// gate.cjs — slot semaphore for heavy commands (tsc, vitest, npm install, builds).
// Usage: gate.cjs [--slots-dir D] [--max N] -- <cmd> [args...]
// Default slots dir: <repo>/.grok-swarm/gate-slots ; default max: host capacity
// max_heavy_tools (fallback 3). Blocks until a slot frees; releases on exit.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep === -1 || sep === argv.length - 1) {
  console.error('usage: gate.cjs [--slots-dir D] [--max N] -- <cmd> [args...]');
  process.exit(2);
}
const opts = {}; const head = argv.slice(0, sep);
for (let i = 0; i < head.length; i += 2) opts[head[i].replace(/^--/, '')] = head[i + 1];
const cmd = argv.slice(sep + 1);

function findUp(name) {
  let d = process.cwd();
  while (true) {
    if (fs.existsSync(path.join(d, name))) return path.join(d, name);
    const p = path.dirname(d); if (p === d) return null; d = p;
  }
}
const ws = findUp('.grok-swarm');
const slotsDir = opts['slots-dir'] || (ws ? path.join(ws, 'gate-slots') : '/tmp/grok-gate-slots');
fs.mkdirSync(slotsDir, { recursive: true });
let max = Number(opts.max);
if (!Number.isFinite(max) || max < 1) {
  max = 3;
  const capFile = ws ? path.join(ws, 'host-capacity.json') : null;
  try { const c = JSON.parse(fs.readFileSync(capFile, 'utf8')); if (Number(c.max_heavy_tools) >= 1) max = Number(c.max_heavy_tools); } catch { /* default */ }
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

function tryAcquire() {
  for (let i = 0; i < max; i++) {
    const slot = path.join(slotsDir, 'slot-' + i + '.pid');
    try {
      const fd = fs.openSync(slot, 'wx');           // atomic claim
      fs.writeSync(fd, String(process.pid)); fs.closeSync(fd);
      return slot;
    } catch {
      try {                                          // stale-pid reclaim
        const txt = fs.readFileSync(slot, 'utf8').trim();
        const holder = Number(txt);
        const valid = Number.isInteger(holder) && holder > 0;
        // Poisoned slot (empty/0/-1: crash between open and write): kill(0/-1, 0)
        // targets the process group and always "succeeds", so alive() would hold
        // the slot forever. The legit open→write gap is microseconds — anything
        // invalid and older than 10s is a crash artifact, reclaim it.
        const stale = valid
          ? !alive(holder)
          : Date.now() - fs.statSync(slot).mtimeMs > 10_000;
        if (stale) { fs.unlinkSync(slot); i--; }
      } catch { /* race — next slot */ }
    }
  }
  return null;
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
let slot = null;
while ((slot = tryAcquire()) === null) Atomics.wait(sleeper, 0, 0, 500);
const release = () => { try { fs.unlinkSync(slot); } catch { /* gone */ } };
process.on('exit', release);
process.on('SIGINT', () => { release(); process.exit(130); });
process.on('SIGTERM', () => { release(); process.exit(143); });

const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
