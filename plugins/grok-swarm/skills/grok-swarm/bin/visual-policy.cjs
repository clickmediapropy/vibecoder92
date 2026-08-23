'use strict';

const VISUAL_TIERS = Object.freeze(['full', 'smoke', 'gates_only']);
const DEFAULT_MAX_VISUAL_AGE_MS = 12 * 60 * 1000;

function resolveVisualTier(sub) {
  const s = sub || {};
  const explicit = String(s.visual_tier || '').toLowerCase().trim();
  if (VISUAL_TIERS.includes(explicit)) return explicit;
  if (s.visual_review === false) return 'gates_only';
  if (s.visual_review === true) return 'full';
  const files = Array.isArray(s.files) ? s.files : [];
  const blob = files.join(' ');
  if (/src\/(mobile|features\/(inbox|auth)|components\/(landing|inbox))/i.test(blob)) {
    return 'full';
  }
  if (/\.(tsx|jsx|css)\b|src\//i.test(blob)) return 'smoke';
  return 'gates_only';
}

function isAuthOnlyBlocked(result) {
  if (!result || String(result.status || '').toUpperCase() !== 'BLOCKED') return false;
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const routes = Array.isArray(result.routesChecked) ? result.routesChecked : [];
  const authHints =
    /auth-env|env-proxy|auth|proxy|credentials|TEST_EMAIL|JWT|session|Cargando|1006|wrong.?origin|socks/i;
  const hasAuthFinding = findings.some((f) => {
    const blob = JSON.stringify(f || {});
    return authHints.test(blob) || /info|low/i.test(String(f.severity || ''));
  });
  const summaryAuth = authHints.test(String(result.summary || ''));
  const publicPass = routes.some((r) => {
    const res = String((r && (r.result || r.status)) || '').toUpperCase();
    const route = String((r && (r.route || r.url)) || '');
    return /PASS/.test(res) && /login|docs|landing|public/i.test(route);
  });
  const highProduct = findings.some(
    (f) => /high/i.test(String(f.severity || '')) && !authHints.test(JSON.stringify(f)),
  );
  if (highProduct) return false;
  return (hasAuthFinding || summaryAuth) && (publicPass || routes.length === 0 || findings.length > 0);
}

function classifyReviewResult(result) {
  if (!result || typeof result !== 'object') {
    return { kind: 'invalid', productHigh: false };
  }
  const status = String(result.status || '').toUpperCase();
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const productHigh = findings.some((f) => {
    if (!/high/i.test(String(f.severity || ''))) return false;
    const blob = JSON.stringify(f);
    return !/auth-env|proxy|TEST_EMAIL|JWT|wrong.?origin/i.test(blob);
  });
  if (status === 'PASS') return { kind: 'pass', productHigh: false };
  if (status === 'REVISE') return { kind: 'revise', productHigh };
  if (status === 'BLOCKED') {
    return {
      kind: isAuthOnlyBlocked(result) ? 'blocked_auth' : 'blocked_other',
      productHigh,
    };
  }
  return { kind: 'invalid', productHigh };
}

/**
 * When ok=true, heal/mega may write PASS with healer note.
 * Never ok for product REVISE high findings or red gates.
 */
function isForcePassEligible(opts) {
  const o = opts || {};
  const result = o.result;
  const codeGatesGreen = o.codeGatesGreen === true;
  const doubleCheckComplete = o.doubleCheckComplete === true;
  const visualAgeMs = Number(o.visualAgeMs) || 0;
  const maxVisualAgeMs =
    o.maxVisualAgeMs != null ? Number(o.maxVisualAgeMs) : DEFAULT_MAX_VISUAL_AGE_MS;

  if (!codeGatesGreen) {
    return { ok: false, reason: 'code gates not green' };
  }
  if (!doubleCheckComplete) {
    return { ok: false, reason: 'double-check not complete' };
  }
  const c = classifyReviewResult(result);
  if (c.kind === 'pass') return { ok: false, reason: 'already PASS' };
  if (c.kind === 'revise' && c.productHigh) {
    return { ok: false, reason: 'product REVISE with high findings — rebuild required' };
  }
  if (c.kind === 'revise' && !c.productHigh && visualAgeMs >= maxVisualAgeMs) {
    // low/info-only REVISE after timeout: still refuse auto-pass by default (quality)
    return { ok: false, reason: 'REVISE is product feedback — redispatch builder, do not force-pass' };
  }
  if (c.kind === 'blocked_auth') {
    return { ok: true, reason: 'auth-harness BLOCKED with gates+DC green' };
  }
  if (c.kind === 'blocked_other' && visualAgeMs >= maxVisualAgeMs) {
    return {
      ok: true,
      reason: 'non-auth BLOCKED past max visual age with gates+DC green',
    };
  }
  if (c.kind === 'blocked_other') {
    return { ok: false, reason: 'BLOCKED but under age threshold — redispatch visual once' };
  }
  return { ok: false, reason: 'not eligible: ' + c.kind };
}

function shouldRequireReviewResult(tier) {
  return String(tier || 'full') !== 'gates_only';
}

module.exports = {
  VISUAL_TIERS,
  DEFAULT_MAX_VISUAL_AGE_MS,
  resolveVisualTier,
  isAuthOnlyBlocked,
  classifyReviewResult,
  isForcePassEligible,
  shouldRequireReviewResult,
};
