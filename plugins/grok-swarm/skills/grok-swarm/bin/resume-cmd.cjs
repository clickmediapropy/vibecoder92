'use strict';

const { workerModel } = require('./model-pin.cjs');

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/**
 * Build a Mode C fix-loop / resume argv for a worker with sessionId.
 * Uses --prompt-file (not bare grok -p) and optional --fork-session.
 */
function buildWorkerResumeCommand({
  agentLabel,
  sessionId,
  worktreePath,
  promptFile,
  model,
  effort = 'medium',
  fork = true,
  maxTurns = 100,
}) {
  if (!promptFile) throw new Error('promptFile required');
  if (!sessionId) throw new Error('sessionId required for resume');
  const resolvedModel = model || workerModel();
  const parts = [
    'SWARM_AGENT_NAME=' + shellQuote(agentLabel),
    'grok',
    '--prompt-file',
    shellQuote(promptFile),
    '-m',
    resolvedModel,
    '--effort',
    effort,
    '--always-approve',
    '--no-subagents',
    '--max-turns',
    String(maxTurns),
    '--output-format',
    'streaming-json',
    '-r',
    sessionId,
  ];
  if (fork && process.env.GROK_SWARM_FORK_ON_FIX !== '0') {
    parts.push('--fork-session');
  }
  if (worktreePath) {
    parts.push('--cwd', shellQuote(worktreePath));
  }
  return parts.join(' ');
}

module.exports = { buildWorkerResumeCommand, shellQuote };
