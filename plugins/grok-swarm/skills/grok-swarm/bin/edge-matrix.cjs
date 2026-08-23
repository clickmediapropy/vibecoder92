'use strict';

/**
 * Edge-case matrix catalog for grok-swarm (single + mega).
 * Pure data + helpers: detect → auto-mitigate (if autoSafe) → escalate.
 * Consumers: heal, mega, operator docs. Never invent gates here.
 *
 * Area keys match ID letter prefix: A lifecycle, B isolation, C visual,
 * D board, E capacity, F quality.
 */

/**
 * @typedef {Object} Edge
 * @property {string} id
 * @property {string} area
 * @property {string} severity  Critical | High | Med | Low
 * @property {boolean} autoSafe
 * @property {string} [healAction]
 * @property {string} operatorHint
 */

/** @type {Record<string, Edge>} */
const EDGES = Object.freeze({
  // --- A Lifecycle / process ---
  A1: Object.freeze({
    id: 'A1',
    area: 'A',
    severity: 'High',
    autoSafe: true,
    healAction: 'coordinator-stall-restart',
    operatorHint:
      'Coord alive, log frozen >3m, builders terminal, tasks only in review → restart coordinator --resume (rate-limit 1/10m)',
  }),
  A2: Object.freeze({
    id: 'A2',
    area: 'A',
    severity: 'High',
    autoSafe: true,
    healAction: 'max-turns-or-exit',
    operatorHint: 'Coordinator process dead mid-mission → swarm coordinator start --resume --daemon',
  }),
  A3: Object.freeze({
    id: 'A3',
    area: 'A',
    severity: 'Med',
    autoSafe: true,
    healAction: 'dashboard-restart',
    operatorHint: 'Dashboard status false or port 4599 taken → dashboard stop/start --daemon --port <n>',
  }),
  A4: Object.freeze({
    id: 'A4',
    area: 'A',
    severity: 'High',
    autoSafe: true,
    healAction: 'mega-meta-restart',
    operatorHint: 'Mega queue frozen / no auto-merge → swarm mega run --daemon --resume',
  }),
  A5: Object.freeze({
    id: 'A5',
    area: 'A',
    severity: 'Med',
    autoSafe: true,
    healAction: 'dedupe-running',
    operatorHint: 'Duplicate running dispatch same task+pid → keep one record on dispatch record',
  }),
  A6: Object.freeze({
    id: 'A6',
    area: 'A',
    severity: 'Med',
    autoSafe: true,
    healAction: 'visual-force-pass-no-open-tasks',
    operatorHint:
      'Healer hasOpen skipped age-pass when board empty → evaluate force-pass via DC + review_result without open-task gate',
  }),

  // --- B Isolation / git ---
  B1: Object.freeze({
    id: 'B1',
    area: 'B',
    severity: 'Critical',
    autoSafe: false,
    healAction: 'main-touch-critical',
    operatorHint: 'Builder TOP==MAIN with product dirty → STOP auto-merge; escalate; redispatch Mode B',
  }),
  B2: Object.freeze({
    id: 'B2',
    area: 'B',
    severity: 'High',
    autoSafe: false,
    healAction: 'scope-drift',
    operatorHint: 'Unexpected paths outside owned files in worktree → note only v1; kill/redelegate Mode B',
  }),
  B3: Object.freeze({
    id: 'B3',
    area: 'B',
    severity: 'High',
    autoSafe: true,
    healAction: 'integrate-merge-conflict',
    operatorHint:
      'Integrate merge conflict → mega auto-aborts, retries -X union on INDEX/learnings paths, ' +
      'writes merge-conflict.json, status=merge_blocked, dispatches builder (never coordinator hand-edit). ' +
      'Do NOT mark mega completed or exit meta daemon until merge ok. Manual: swarm mega merge --id <mega> --json',
  }),
  B4: Object.freeze({
    id: 'B4',
    area: 'B',
    severity: 'Med',
    autoSafe: true,
    healAction: 'worktree-name-collision',
    operatorHint: 'Stale worktree name blocks create → grok worktree rm stale -f or pick new name',
  }),
  B5: Object.freeze({
    id: 'B5',
    area: 'B',
    severity: 'Med',
    autoSafe: true,
    healAction: 'doctor-soft-leftovers',
    operatorHint: 'Soft doctor leftovers block next mega → cleanup orphan wt + vite; mega doctor --expect-clean',
  }),

  // --- C Visual / auth ---
  C1: Object.freeze({
    id: 'C1',
    area: 'C',
    severity: 'High',
    autoSafe: true,
    healAction: 'proxy-unset-hint',
    operatorHint: 'Socks/HTTP proxy → Convex WS 1006 / Cargando → unset proxy for vite + agent-browser + curl',
  }),
  C2: Object.freeze({
    id: 'C2',
    area: 'C',
    severity: 'High',
    autoSafe: true,
    healAction: 'auth-force-pass',
    operatorHint:
      'Wrong-origin JWT: login OK, /app redirects → force-pass when visual-policy ok (gates+DC green) or re-auth same origin',
  }),
  C3: Object.freeze({
    id: 'C3',
    area: 'C',
    severity: 'Med',
    autoSafe: true,
    healAction: 'test-email-seed',
    operatorHint: 'Missing TEST_EMAIL/PASSWORD seed → seed .env.local into worktree; redispatch visual',
  }),
  C4: Object.freeze({
    id: 'C4',
    area: 'C',
    severity: 'High',
    autoSafe: false,
    healAction: 'revise-cap',
    operatorHint: 'Product REVISE ×3 → never force-pass; cap fix loops; blocked + escalate if still high',
  }),
  C5: Object.freeze({
    id: 'C5',
    area: 'C',
    severity: 'High',
    autoSafe: true,
    healAction: 'visual-no-result-age-pass',
    operatorHint:
      'Visual PID dead, no review_result, age >12m, gates+DC green → force-pass via visual-policy with --auto-visual-pass',
  }),
  C6: Object.freeze({
    id: 'C6',
    area: 'C',
    severity: 'High',
    autoSafe: false,
    healAction: 'soft-gates-false-green',
    operatorHint: 'Soft gates inference for force-pass risk → require hard green gates+DC; never invent gates',
  }),

  // --- D Board / plan integrity ---
  D1: Object.freeze({
    id: 'D1',
    area: 'D',
    severity: 'Med',
    autoSafe: true,
    healAction: 'cancelled-dep-scrub',
    operatorHint: 'Cancelled task with missing depends_on IDs → patch dependsOn to [] so swarm check passes',
  }),
  D2: Object.freeze({
    id: 'D2',
    area: 'D',
    severity: 'Med',
    autoSafe: true,
    healAction: 'stale-task-scrub',
    operatorHint: 'Ghost tickets from prior swarm without --fresh → archive or init --fresh before new mission',
  }),
  D3: Object.freeze({
    id: 'D3',
    area: 'D',
    severity: 'High',
    autoSafe: false,
    operatorHint: 'Cycle in depends_on → ready empty forever; fix plan deps manually (no auto rewrite)',
  }),
  D4: Object.freeze({
    id: 'D4',
    area: 'D',
    severity: 'High',
    autoSafe: true,
    healAction: 'peer-lease-clash-pause',
    operatorHint: 'Cross-mega lease clash after launch → mega tick re-check; pause offending sub',
  }),
  D5: Object.freeze({
    id: 'D5',
    area: 'D',
    severity: 'Med',
    autoSafe: true,
    healAction: 'gates-only-skip-visual',
    operatorHint: 'gates_only pack still dispatched visual → skip visual dispatch; mark visual skipped',
  }),

  // --- E Host / capacity ---
  E1: Object.freeze({
    id: 'E1',
    area: 'E',
    severity: 'Med',
    autoSafe: true,
    healAction: 'queue-capacity-reason',
    operatorHint: '20 packs, only 16 coord slots → status shows queued_reason capacity vs depends_on (not hung)',
  }),
  E2: Object.freeze({
    id: 'E2',
    area: 'E',
    severity: 'High',
    autoSafe: false,
    healAction: 'vite-over-cap',
    operatorHint: 'Live vite ≫ max_dev_servers → warn; refuse new visual unless --force; cleanup orphans',
  }),
  E3: Object.freeze({
    id: 'E3',
    area: 'E',
    severity: 'High',
    autoSafe: false,
    healAction: 'dual-fe-mega-clash',
    operatorHint: 'Two FE megas same host → mega check hard problem unless --force',
  }),
  E4: Object.freeze({
    id: 'E4',
    area: 'E',
    severity: 'Low',
    autoSafe: true,
    healAction: 'basename-filter',
    operatorHint: 'Dev server count includes foreign projects → countLiveDevServers({ repoBasename }) default',
  }),
  E5: Object.freeze({
    id: 'E5',
    area: 'E',
    severity: 'Med',
    autoSafe: true,
    healAction: 'log-stall',
    operatorHint: 'Builder log 0 bytes >90s while pid alive → act log-stall note; redispatch (no kill v1)',
  }),

  // --- F Quality false negatives ---
  F1: Object.freeze({
    id: 'F1',
    area: 'F',
    severity: 'Critical',
    autoSafe: false,
    healAction: 'refuse-merge-no-dc',
    operatorHint: 'Force-pass / merge without Double-check result: complete → refuse merge',
  }),
  F2: Object.freeze({
    id: 'F2',
    area: 'F',
    severity: 'High',
    autoSafe: false,
    healAction: 'refuse-mark-no-dc',
    operatorHint: 'Missing double-check file on MAIN → refuse mark done / merge',
  }),
  F3: Object.freeze({
    id: 'F3',
    area: 'F',
    severity: 'Med',
    autoSafe: false,
    operatorHint:
      'Editable install points at worktree → reinstall on MAIN (pip install -e); use PYTHONPATH=$WT/src for wt verify',
  }),
});

/**
 * @returns {Edge[]}
 */
function listEdges() {
  return Object.keys(EDGES)
    .sort()
    .map((id) => EDGES[id]);
}

/**
 * @param {string} id
 * @returns {boolean}
 */
function isAutoSafe(id) {
  const e = EDGES[String(id || '')];
  return e ? e.autoSafe === true : false;
}

/**
 * @param {string} area  letter A–F or full name alias
 * @returns {Edge[]}
 */
function byArea(area) {
  const raw = String(area || '').trim();
  const aliases = {
    lifecycle: 'A',
    isolation: 'B',
    visual: 'C',
    board: 'D',
    capacity: 'E',
    quality: 'F',
  };
  const key = aliases[raw.toLowerCase()] || raw.toUpperCase();
  return listEdges().filter((e) => e.area === key);
}

module.exports = {
  EDGES,
  listEdges,
  isAutoSafe,
  byArea,
};
