/**
 * Host memory stats for swarm watch / dashboard + low-memory auto-pause guard.
 * Zero third-party deps. Linux /proc/meminfo (MemAvailable preferred).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_MIN_FREE_GB = 2;
const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * @param {string} [text] optional meminfo text (tests)
 * @returns {{
 *   totalBytes: number, freeBytes: number, availableBytes: number, usedBytes: number,
 *   buffersBytes: number, cachedBytes: number,
 *   totalGb: number, freeGb: number, availableGb: number, usedGb: number,
 *   pctUsed: number, pctAvailable: number,
 *   source: string, at: number
 * }}
 */
function readHostMemory(text) {
  let raw = text;
  if (raw == null) {
    try {
      raw = fs.readFileSync('/proc/meminfo', 'utf8');
    } catch {
      const totalBytes = os.totalmem();
      const freeBytes = os.freemem();
      const usedBytes = Math.max(0, totalBytes - freeBytes);
      const gb = (b) => Math.round((b / 1024 ** 3) * 100) / 100;
      return {
        totalBytes,
        freeBytes,
        availableBytes: freeBytes,
        usedBytes,
        buffersBytes: 0,
        cachedBytes: 0,
        totalGb: gb(totalBytes),
        freeGb: gb(freeBytes),
        availableGb: gb(freeBytes),
        usedGb: gb(usedBytes),
        pctUsed: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
        pctAvailable: totalBytes > 0 ? Math.round((freeBytes / totalBytes) * 1000) / 10 : 0,
        source: 'node-os',
        at: Date.now(),
      };
    }
  }
  const getKb = (key) => {
    const m = String(raw).match(new RegExp('^' + key + ':\\s*(\\d+)', 'm'));
    return m ? Number(m[1]) : 0;
  };
  const totalKb = getKb('MemTotal');
  const freeKb = getKb('MemFree');
  const availKb = getKb('MemAvailable') || freeKb;
  const buffersKb = getKb('Buffers');
  const cachedKb = getKb('Cached');
  const toB = (kb) => kb * 1024;
  const totalBytes = toB(totalKb);
  const freeBytes = toB(freeKb);
  const availableBytes = toB(availKb);
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const gb = (b) => Math.round((b / (1024 ** 3)) * 100) / 100;
  const pctUsed = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0;
  const pctAvailable = totalBytes > 0 ? Math.round((availableBytes / totalBytes) * 1000) / 10 : 0;
  return {
    totalBytes,
    freeBytes,
    availableBytes,
    usedBytes,
    buffersBytes: toB(buffersKb),
    cachedBytes: toB(cachedKb),
    totalGb: gb(totalBytes),
    freeGb: gb(freeBytes),
    availableGb: gb(availableBytes),
    usedGb: gb(usedBytes),
    pctUsed,
    pctAvailable,
    source: 'proc-meminfo',
    at: Date.now(),
  };
}

function emptyMemory(source) {
  return {
    totalBytes: 0,
    freeBytes: 0,
    availableBytes: 0,
    usedBytes: 0,
    buffersBytes: 0,
    cachedBytes: 0,
    totalGb: 0,
    freeGb: 0,
    availableGb: 0,
    usedGb: 0,
    pctUsed: 0,
    pctAvailable: 0,
    source: source || 'empty',
    at: Date.now(),
  };
}

/**
 * Human one-liner for TUI.
 * @param {ReturnType<typeof readHostMemory>} mem
 */
function formatMemoryLine(mem) {
  if (!mem || !mem.totalGb) return 'mem n/a';
  return (
    'RAM ' +
    mem.usedGb +
    '/' +
    mem.totalGb +
    'G used (' +
    mem.pctUsed +
    '%)  avail ' +
    mem.availableGb +
    'G  free ' +
    mem.freeGb +
    'G'
  );
}

function guardStatePath(registryRoot) {
  return path.join(registryRoot, 'host-memory-guard.json');
}

function readGuardState(registryRoot) {
  try {
    return JSON.parse(fs.readFileSync(guardStatePath(registryRoot), 'utf8'));
  } catch {
    return null;
  }
}

function writeGuardState(registryRoot, state) {
  try {
    fs.mkdirSync(path.dirname(guardStatePath(registryRoot)), { recursive: true });
    fs.writeFileSync(guardStatePath(registryRoot), JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch {
    /* best-effort */
  }
}

/**
 * Decide if available RAM is below threshold.
 * Uses MemAvailable (not MemFree) — free can be low while reclaimable cache is high.
 *
 * @param {object} mem
 * @param {number} minFreeGb
 */
function isLowMemory(mem, minFreeGb) {
  const thr = Number(minFreeGb);
  const threshold = Number.isFinite(thr) && thr > 0 ? thr : DEFAULT_MIN_FREE_GB;
  if (!mem || !mem.totalBytes) return false;
  // node-os is os.freemem(): on macOS the page cache counts as "used", so free
  // sits near 0 on any healthy host and the guard would pause --all spuriously.
  // Display the numbers, never trigger the guard from them.
  if (mem.source === 'node-os') return false;
  return Number(mem.availableGb) < threshold;
}

/**
 * Build public hostMemory payload for API / watch.
 * @param {object} [opts]
 * @param {number} [opts.minFreeGb]
 * @param {string} [opts.meminfoText] test inject
 */
function hostMemoryPayload(opts) {
  const o = opts || {};
  const minFreeGb =
    o.minFreeGb != null && Number.isFinite(Number(o.minFreeGb))
      ? Number(o.minFreeGb)
      : DEFAULT_MIN_FREE_GB;
  const mem = readHostMemory(o.meminfoText);
  const low = isLowMemory(mem, minFreeGb);
  return {
    ...mem,
    minFreeGb,
    low,
    line: formatMemoryLine(mem),
  };
}

module.exports = {
  DEFAULT_MIN_FREE_GB,
  DEFAULT_COOLDOWN_MS,
  readHostMemory,
  formatMemoryLine,
  isLowMemory,
  hostMemoryPayload,
  guardStatePath,
  readGuardState,
  writeGuardState,
};
