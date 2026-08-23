'use strict';
const fs = require('fs');

/**
 * Scan a streaming-json / NDJSON grok log for terminal + spend fields.
 * Caps read size so multi-MB logs stay cheap on dashboard polls.
 */
function analyzeDispatchLog(logFile) {
  const empty = {
    exists: false,
    hasEnd: false,
    hasError: false,
    sessionId: null,
    logMtime: 0,
    logSize: 0,
    usage: null,
    totalCostUsd: null,
    numTurns: null,
    stopReason: null,
  };
  if (!logFile || !fs.existsSync(logFile)) return empty;
  let st;
  try {
    st = fs.statSync(logFile);
  } catch {
    return empty;
  }
  const maxBytes = 512 * 1024;
  let text = '';
  try {
    if (st.size <= maxBytes) {
      text = fs.readFileSync(logFile, 'utf8');
    } else {
      const fd = fs.openSync(logFile, 'r');
      try {
        const buf = Buffer.alloc(maxBytes);
        fs.readSync(fd, buf, 0, maxBytes, st.size - maxBytes);
        text = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    return {
      ...empty,
      exists: true,
      logMtime: st.mtimeMs,
      logSize: st.size,
    };
  }

  let hasEnd = false;
  let hasError = false;
  let sessionId = null;
  let usage = null;
  let totalCostUsd = null;
  let numTurns = null;
  let stopReason = null;

  for (const line of text.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let o;
    try {
      o = JSON.parse(trimmed);
    } catch {
      const endIdx = trimmed.lastIndexOf('{"type":"end"');
      if (endIdx >= 0) {
        try {
          o = JSON.parse(trimmed.slice(endIdx));
        } catch {
          o = null;
        }
      }
      if (!o) {
        const errIdx = trimmed.lastIndexOf('{"type":"error"');
        if (errIdx >= 0) {
          try {
            o = JSON.parse(trimmed.slice(errIdx));
          } catch {
            o = null;
          }
        }
      }
    }
    if (!o || typeof o !== 'object') continue;
    if (o.type === 'end') {
      hasEnd = true;
      if (o.sessionId) sessionId = o.sessionId;
      if (o.usage && typeof o.usage === 'object') usage = o.usage;
      if (typeof o.total_cost_usd === 'number') totalCostUsd = o.total_cost_usd;
      if (typeof o.num_turns === 'number') numTurns = o.num_turns;
      if (typeof o.stopReason === 'string') stopReason = o.stopReason;
    }
    if (o.type === 'error') hasError = true;
  }
  if (!hasEnd && /"type"\s*:\s*"end"/.test(text)) hasEnd = true;
  if (!hasError && /"type"\s*:\s*"error"/.test(text)) hasError = true;
  if (!sessionId) {
    const m = text.match(/"sessionId"\s*:\s*"([^"]+)"/);
    if (m) sessionId = m[1];
  }

  return {
    exists: true,
    hasEnd,
    hasError,
    sessionId,
    logMtime: st.mtimeMs,
    logSize: st.size,
    usage,
    totalCostUsd,
    numTurns,
    stopReason,
  };
}

module.exports = { analyzeDispatchLog };
