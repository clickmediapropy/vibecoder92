'use strict';

const fs = require('fs');
const path = require('path');

function readModelPin() {
  const file = path.join(__dirname, 'model-pin.env');
  const out = {};
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    out[t.slice(0, i)] = t.slice(i + 1).trim();
  }
  return out;
}

function workerModel() {
  return process.env.GROK_SWARM_WORKER_MODEL || readModelPin().GROK_SWARM_WORKER_MODEL_DEFAULT;
}

function coordinatorModel() {
  return readModelPin().GROK_SWARM_COORDINATOR_MODEL_DEFAULT;
}

module.exports = { readModelPin, workerModel, coordinatorModel };
