/**
 * Browser bundle of mission-root helpers (see mission-root.cjs for Node tests).
 * BUG 2026-08-07: never treat registry.default named packs as overview.
 */
(function (root) {
  "use strict";
  function isMissionRoot(id) {
    return !id || id === "overview" || id === "__all__" || id === "default";
  }
  var PACK_RE = /gh-issues|^mega-|-pack-/;
  function looksLikePack(id) {
    return PACK_RE.test(String(id || ""));
  }
  // Concurrent named missions (swarm init --name foo) are real swarms, unlike
  // mega packs where "default" is only a rollup mirror board.
  function hasNamedPeers(swarms) {
    return (swarms || []).some(function (s) {
      return s && s.id && s.id !== "default" && !looksLikePack(s.id);
    });
  }
  function tabLabel(sw, reg, opts) {
    opts = opts || {};
    var label = (sw && (sw.title || sw.id)) || "";
    if (sw && sw.id === "default" && opts.namedPeers) {
      // fall through to normal labeling: default is a real swarm here
    } else if (sw && (sw.id === "default" || sw.id === "overview" || sw.id === "__all__")) {
      return opts.isNarrow ? "Main" : "Main, all packs";
    }
    var idm = String((sw && sw.id) || "").match(/iss-(\d+(?:-\d+)*)/);
    if (opts.isNarrow && idm) return "#" + idm[1].replace(/-/g, "/");
    if (label.length > 28) {
      var shortId = String((sw && sw.id) || "");
      if (shortId && shortId.length <= 28) return shortId;
      label = label.slice(0, 26) + "...";
    }
    return label;
  }
  function isVisiblePack(sw, opts) {
    opts = opts || {};
    if (!sw || !sw.id) return false;
    if (opts.activeId && sw.id === opts.activeId) return true;
    if (isMissionRoot(sw.id)) return true;
    if (opts.showAll) return true;
    if (sw.paused || sw.status === "paused") return false;
    var st = sw.stats || {};
    var total = st.total || 0;
    var done = st.done || 0;
    if (total > 0 && done >= total) return false;
    if (sw.status === "done" || sw.status === "archived" || sw.status === "completed") return false;
    return true;
  }
  root.MissionRoot = {
    isMissionRoot: isMissionRoot,
    tabLabel: tabLabel,
    isVisiblePack: isVisiblePack,
    looksLikePack: looksLikePack,
    hasNamedPeers: hasNamedPeers,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
