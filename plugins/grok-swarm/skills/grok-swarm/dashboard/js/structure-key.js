/**
 * Structural fingerprint for Mission Control soft-vs-hard poll updates.
 * Pure (no DOM). Browser: window/globalThis.SwarmStructureKey.
 * Node tests load this same file via vm (see bin/dashboard-structure-key.test.mjs).
 *
 * /api/state always stamps updatedAt=Date.now() and recomputes elapsedMs / hostMemory,
 * so those MUST NOT participate in the key — otherwise every 2s poll rebuilds the board.
 */
(function (root) {
  "use strict";

  function structureKey(s) {
    if (!s) return "";
    var st = s.stats || {};
    var c = st.counts || {};
    var tasks = (s.tasks || [])
      .map(function (t) {
        return [t.id, t.status, t.title || "", t.ownerAgentLabel || "", t.blockedReason || "", t.swarmId || ""].join(
          "\x1f",
        );
      })
      .sort()
      .join("\x1e");
    var runs = (s.runningDispatches || [])
      .map(function (r) {
        return [r.id, r.taskId || "", r.status || "", r.pid || "", r.agentLabel || "", r.worktree || ""].join("\x1f");
      })
      .sort()
      .join("\x1e");
    var hist = (s.dispatchHistory || [])
      .slice(0, 10)
      .map(function (r) {
        return [r.id, r.status || "", r.taskId || ""].join("\x1f");
      })
      .join("\x1e");
    var agents = (s.agentWorkload || [])
      .map(function (a) {
        return [a.label || "", a.role || "", a.active || 0, a.done || 0].join("\x1f");
      })
      .join("\x1e");
    var feed = (s.activityFeed || [])
      .slice(0, 12)
      .map(function (a) {
        return [a.kind || a.type || "", a.taskId || "", a.message || a.text || ""].join("\x1f");
      })
      .join("\x1e");
    var done = (s.recentDone || [])
      .slice(0, 8)
      .map(function (t) {
        return t.id || t.taskId || "";
      })
      .join(",");
    var pause = s.paused
      ? "1:" + (s.paused.reason || "") + ":" + ((s.paused.interrupted || []).length || 0)
      : "0";
    var health = s.boardHealth
      ? (s.boardHealth.ok ? "ok" : "bad") +
        ":" +
        ((s.boardHealth.problems || [])
          .map(function (p) {
            return (p.kind || "") + ":" + (p.message || "");
          })
          .join("|") || "")
      : "ok";
    var packs = "";
    if (s._overview && s._overview.swarms) {
      packs = s._overview.swarms
        .map(function (sw) {
          var st2 = sw.stats || {};
          return [
            sw.id,
            sw.live || 0,
            sw.building || 0,
            st2.done || 0,
            st2.total || 0,
            (st2.counts && st2.counts.blocked) || 0,
          ].join("\x1f");
        })
        .join("\x1e");
    }
    var daemons = "";
    if (s.operator && s.operator.daemons) {
      var d = s.operator.daemons;
      daemons = [
        d.coordinator && d.coordinator.alive ? "c1" : "c0",
        d.healer && d.healer.alive ? "h1" : "h0",
        d.dashboard && d.dashboard.alive ? "d1" : "d0",
        (d.dashboard && d.dashboard.port) || "",
      ].join("\x1f");
    }
    return [
      s.swarmId || "",
      s.goal && s.goal.title,
      s.goal && s.goal.status,
      st.done || 0,
      st.total || 0,
      st.pct || 0,
      c.building || 0,
      c.review || 0,
      c.blocked || 0,
      c.open || 0,
      c.assigned || 0,
      c.planning || 0,
      pause,
      health,
      tasks,
      runs,
      hist,
      agents,
      feed,
      done,
      packs,
      daemons,
    ].join("\x1d");
  }

  /**
   * Decide soft vs hard from two consecutive state payloads.
   * Soft: same structureKey (clock/RAM-only noise). Hard: key changed.
   */
  function updatePath(prev, next) {
    var prevKey = structureKey(prev);
    var nextKey = structureKey(next);
    return {
      prevKey: prevKey,
      nextKey: nextKey,
      path: prev && prevKey === nextKey ? "soft" : "hard",
    };
  }

  var api = { structureKey: structureKey, updatePath: updatePath };
  if (root) root.SwarmStructureKey = api;
  /* Node CJS consumers (package type module → use .cjs loader or vm). */
  if (typeof module === "object" && module && module.exports && typeof module.exports === "object") {
    try {
      module.exports.structureKey = structureKey;
      module.exports.updatePath = updatePath;
    } catch (err) {
      /* ESM interop: ignore */
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this);
