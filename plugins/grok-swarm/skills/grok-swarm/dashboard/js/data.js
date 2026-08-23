/**
 * SwarmStore - polling + normalization layer for Mission Control.
 * Owns: registry, smart poll cadence, overview normalization, status-transition
 * diffing, stat history ring buffers, log fetching with ANSI cleaning, prefs.
 * No DOM work happens here.
 */
(function () {
  "use strict";

  /* Legacy localStorage keys. Do not rename: they carry existing user prefs. */
  var LS = {
    swarm: "grok-swarm-dash-swarm",
    view: "grok-swarm-dash-view",
    mview: "grok-swarm-dash-mview",
    cinematic: "grok-swarm-cinematic",
  };

  var HISTORY_LABELS = ["Live", "Building", "Blocked", "Review", "Queued", "Done"];
  var HISTORY_MAX = 24;

  var listeners = Object.create(null);
  var registry = { default: null, swarms: [], repoName: "" };
  var state = null;
  var history = {};
  var taskStatuses = {};
  var lastUpdatedAt = 0;
  var failures = 0;
  var wasDown = false;
  var pollTimer = null;
  var started = false;
  var inFlight = false;
  var selectedSwarm = "";
  var logPrevSets = Object.create(null);

  HISTORY_LABELS.forEach(function (l) {
    history[l] = [];
  });

  /* ---------- utils ---------- */

  var ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

  function esc(s) {
    return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) {
      return ESC_MAP[c];
    });
  }

  function fmtDur(ms) {
    var s = Math.max(0, Math.floor((ms || 0) / 1000));
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m" + String(s % 60).padStart(2, "0") + "s";
    var h = Math.floor(m / 60);
    return h + "h" + String(m % 60).padStart(2, "0") + "m";
  }

  function relTime(ts) {
    if (!ts) return "";
    var d = Date.now() - Number(ts);
    if (d < 0) d = 0;
    if (d < 60000) return Math.max(1, Math.floor(d / 1000)) + "s ago";
    if (d < 3600000) return Math.floor(d / 60000) + "m ago";
    if (d < 86400000) return Math.floor(d / 3600000) + "h ago";
    return Math.floor(d / 86400000) + "d ago";
  }

  function emit(event, payload) {
    var fns = listeners[event];
    if (!fns) return;
    for (var i = 0; i < fns.length; i++) {
      try {
        fns[i](payload);
      } catch (err) {
        console.warn("SwarmStore listener failed for " + event, err);
      }
    }
  }

  function on(event, fn) {
    if (typeof fn !== "function") return function () {};
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(fn);
    return function off() {
      var fns = listeners[event] || [];
      var i = fns.indexOf(fn);
      if (i >= 0) fns.splice(i, 1);
    };
  }

  /* ---------- prefs ---------- */

  function prefGet(name, fallback) {
    var key = LS[name];
    if (!key) return fallback;
    try {
      var v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch (err) {
      return fallback;
    }
  }

  function prefSet(name, value) {
    var key = LS[name];
    if (!key) return;
    try {
      localStorage.setItem(key, String(value));
    } catch (err) {
      /* storage blocked, prefs simply do not persist */
    }
  }

  var prefs = { keys: LS, get: prefGet, set: prefSet };

  /* ---------- history ---------- */

  function pushHistory(s) {
    var st = (s && s.stats) || {};
    var c = st.counts || {};
    var live = (s && s.runningDispatches ? s.runningDispatches.length : 0) || st.runningDispatches || 0;
    var vals = {
      Live: live,
      Building: c.building || 0,
      Blocked: c.blocked || 0,
      Review: c.review || 0,
      Queued: (c.open || 0) + (c.assigned || 0),
      Done: st.done || 0,
    };
    HISTORY_LABELS.forEach(function (label) {
      var arr = history[label];
      arr.push(Number(vals[label]) || 0);
      if (arr.length > HISTORY_MAX) arr.shift();
    });
  }

  /* ---------- registry ---------- */

  function loadRegistry() {
    return fetch("/api/swarms", { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("registry " + res.status);
        return res.json();
      })
      .then(function (reg) {
        registry = {
          default: reg.default || null,
          swarms: reg.swarms || [],
          repoName: reg.repoName || "",
        };
      })
      .catch(function () {
        /* keep the empty registry, single-swarm mode still works */
      })
      .then(function () {
        if (!selectedSwarm) {
          selectedSwarm = prefGet("swarm", "") || registry.default || "";
        }
        emit("registry", registry);
        return registry;
      });
  }

  function isMissionRoot(id) {
    // Shared pure helper — see mission-root.js (regression: never use registry.default).
    if (typeof MissionRoot !== "undefined" && MissionRoot.isMissionRoot) {
      return MissionRoot.isMissionRoot(id);
    }
    return !id || id === "overview" || id === "__all__" || id === "default";
  }

  function hasPeerPacks() {
    return (registry.swarms || []).some(function (s) {
      return !isMissionRoot(s.id);
    });
  }

  /* ---------- normalization ---------- */

  function normalizeOverview(ov) {
    var agg = ov.aggregate || ov.stats || {};
    return {
      apiVersion: ov.apiVersion,
      swarmId: "overview",
      repoName: ov.repoName || registry.repoName || "",
      updatedAt: ov.updatedAt || Date.now(),
      goal: ov.goal || { title: "Mission overview (all packs)", status: "active" },
      stats: agg,
      eta: ov.eta || null,
      paused: ov.paused || null,
      resumePlan: ov.resumePlan || null,
      runningDispatches: ov.runningDispatches || [],
      dispatchHistory: ov.dispatchHistory || [],
      agentWorkload: ov.agentWorkload || [],
      activityFeed: ov.activityFeed || [],
      recentDone: ov.recentDone || [],
      friendlyStatus: {},
      boardHealth: ov.boardHealth || { ok: true, problems: [] },
      hostMemory: ov.hostMemory,
      memoryGuard: ov.memoryGuard,
      tasks: (ov.activeTasks || []).map(function (t) {
        return {
          id: t.id,
          title: t.title,
          status: t.status,
          ownerAgentLabel: t.ownerAgentLabel,
          blockedReason: t.blockedReason,
          swarmId: t.swarmId,
          swarmTitle: t.swarmTitle,
          ownedFiles: t.ownedFiles || [],
          acceptanceCriteria: t.acceptanceCriteria || [],
          dependsOn: t.dependsOn || [],
          notes: t.notes || [],
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          completedAt: t.completedAt,
        };
      }),
      _overview: ov,
    };
  }

  function normalizeSingle(s) {
    s.tasks = s.tasks || [];
    s.runningDispatches = s.runningDispatches || [];
    s.dispatchHistory = s.dispatchHistory || [];
    s.agentWorkload = s.agentWorkload || s.agents || [];
    s.activityFeed = s.activityFeed || [];
    s.recentDone = s.recentDone || [];
    s.friendlyStatus = s.friendlyStatus || {};
    s.stats = s.stats || { counts: {}, done: 0, total: 0, pct: 0 };
    s.boardHealth = s.boardHealth || { ok: true, problems: [] };
    if (!s.repoName) s.repoName = registry.repoName || "";
    s._overview = null;
    return s;
  }

  /* ---------- transitions ---------- */

  function diffTransitions(s) {
    var changes = [];
    var next = {};
    (s.tasks || []).forEach(function (t) {
      var prev = taskStatuses[t.id];
      if (prev && prev !== t.status) changes.push({ id: t.id, from: prev, to: t.status });
      next[t.id] = t.status;
    });
    taskStatuses = next;
    return changes;
  }


  /**
   * Structural fingerprint for "did the board actually change?"
   * Canonical implementation: dashboard/js/structure-key.js (loaded before this file).
   * Falls back to a minimal inline key only if the pure module failed to load.
   */
  var structureKey =
    (window.SwarmStructureKey && typeof window.SwarmStructureKey.structureKey === "function"
      ? window.SwarmStructureKey.structureKey
      : function structureKeyFallback(s) {
          if (!s) return "";
          var st = s.stats || {};
          var c = st.counts || {};
          var tasks = (s.tasks || [])
            .map(function (t) {
              return [t.id, t.status].join("\x1f");
            })
            .sort()
            .join("\x1e");
          var runs = (s.runningDispatches || [])
            .map(function (r) {
              return [r.id, r.status || ""].join("\x1f");
            })
            .sort()
            .join("\x1e");
          return [s.swarmId || "", st.done || 0, st.total || 0, c.building || 0, c.blocked || 0, tasks, runs].join(
            "\x1d",
          );
        });

  var lastStructureKey = "";

  /* ---------- polling ---------- */

  var abortCtrl = null;
  var FETCH_TIMEOUT_MS = 9000;

  function isNarrowViewport() {
    try {
      return window.matchMedia("(max-width: 767px)").matches;
    } catch (e) {
      return false;
    }
  }

  function pollIntervalMs(s) {
    if (document.hidden) return 0;
    if (!s) return isNarrowViewport() ? 1500 : 2000;
    var st = s.stats || {};
    var active =
      (s.runningDispatches || []).length > 0 || (st.total || 0) > (st.done || 0);
    /* Mobile Safari background-throttles timers; while visible + active, poll a bit faster. */
    if (active) return isNarrowViewport() ? 1500 : 2000;
    return isNarrowViewport() ? 4000 : 5000;
  }

  function schedule(s) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    var ms = pollIntervalMs(s);
    if (ms > 0) pollTimer = setTimeout(function () {
      poll(false);
    }, ms);
  }

  /**
   * @param {boolean} [force] when true (focus / pageshow / online / tab switch),
   *   abort any hung in-flight fetch and always hit the network.
   */
  function poll(force) {
    if (document.hidden && !force) return Promise.resolve(state);
    if (inFlight && !force) return Promise.resolve(state);
    if (inFlight && force && abortCtrl) {
      try {
        abortCtrl.abort();
      } catch (e) {
        /* ignore */
      }
    }
    inFlight = true;
    abortCtrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timedOut = false;
    var timeoutId = setTimeout(function () {
      timedOut = true;
      if (abortCtrl) {
        try {
          abortCtrl.abort();
        } catch (e) {
          /* ignore */
        }
      }
    }, FETCH_TIMEOUT_MS);

    // "default" is only a rollup alias when the peers are mega packs; with
    // concurrent named swarms it is a real mission whose own board must be
    // reachable — only ""/overview/__all__ mean the aggregate then.
    var namedPeers =
      typeof MissionRoot !== "undefined" && MissionRoot.hasNamedPeers
        ? MissionRoot.hasNamedPeers(registry.swarms)
        : false;
    var useOverview =
      hasPeerPacks() &&
      (selectedSwarm === "default"
        ? !namedPeers
        : isMissionRoot(selectedSwarm));
    var url = useOverview
      ? "/api/state?view=overview"
      : "/api/state" + (selectedSwarm ? "?swarm=" + encodeURIComponent(selectedSwarm) : "");

    var opts = { cache: "no-store" };
    if (abortCtrl) opts.signal = abortCtrl.signal;

    return fetch(url, opts)
      .then(function (res) {
        if (!res.ok) throw new Error("state " + res.status);
        return res.json();
      })
      .then(function (raw) {
        clearTimeout(timeoutId);
        var s = useOverview ? normalizeOverview(raw) : normalizeSingle(raw);
        failures = 0;
        if (wasDown) {
          wasDown = false;
          emit("connok", null);
        }
        var key = structureKey(s);
        var unchanged = !!state && key === lastStructureKey && !force;
        lastUpdatedAt = s.updatedAt || Date.now();
        if (unchanged) {
          /* Soft path: only RAM / clocks / footer change. No full board rebuild. */
          state = s;
          emit("tick", s);
        } else {
          lastStructureKey = key;
          var changes = diffTransitions(s);
          pushHistory(s);
          state = s;
          for (var i = 0; i < changes.length; i++) emit("transition", changes[i]);
          emit("state", s);
        }
        inFlight = false;
        abortCtrl = null;
        schedule(s);
        return s;
      })
      .catch(function (err) {
        clearTimeout(timeoutId);
        inFlight = false;
        abortCtrl = null;
        /* Aborts from force-refresh are not failures. */
        if (err && err.name === "AbortError" && !timedOut) {
          schedule(state);
          return state;
        }
        failures += 1;
        if (failures >= 3 && !wasDown) {
          wasDown = true;
          emit("connlost", null);
        }
        schedule(state);
        return state;
      });
  }

  function selectSwarm(id) {
    selectedSwarm = id || "";
    prefSet("swarm", selectedSwarm);
    lastUpdatedAt = 0;
    lastStructureKey = "";
    taskStatuses = {};
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    return poll(true);
  }

  /* ---------- log tail ---------- */

  /* Strip ANSI escapes plus control chars. Builder logs are raw terminal output
     and render as gibberish otherwise. Escapes only, never literal control bytes. */
  function cleanLine(s) {
    return String(s)
      .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  }

  function eventText(ev) {
    if (typeof ev === "string") return cleanLine(ev);
    if (!ev || typeof ev !== "object") return "";
    if (typeof ev.data === "string" && ev.data) return cleanLine(ev.data);
    if (typeof ev.text === "string" && ev.text) return cleanLine(ev.text);
    if (typeof ev.message === "string" && ev.message) return cleanLine(ev.message);
    /* Nested tool payloads (if server ever forwards raw) */
    if (Array.isArray(ev.content)) {
      var parts = [];
      for (var i = 0; i < ev.content.length; i++) {
        var c = ev.content[i];
        if (!c) continue;
        if (typeof c === "string") parts.push(c);
        else if (c.content && typeof c.content.text === "string") parts.push(c.content.text);
        else if (typeof c.text === "string") parts.push(c.text);
      }
      if (parts.length) return cleanLine(parts.join(""));
    }
    if (ev.rawOutput && typeof ev.rawOutput.output_for_prompt === "string") {
      return cleanLine(ev.rawOutput.output_for_prompt);
    }
    /* Avoid dumping huge objects as one left-aligned JSON wall */
    if (ev.type && !ev.data) return "";
    try {
      return cleanLine(JSON.stringify(ev));
    } catch (e) {
      return "";
    }
  }

  function eventClass(ev, text) {
    var type = typeof ev === "string" ? "" : ev.type || "";
    if (type === "thought") return "thought";
    if (type === "tool_call" || type === "tool_call_update") return "tool_call_update";
    if (type === "error") return "error";
    if (type === "raw") return "raw";
    if (/\berror\b/i.test(text)) return "error";
    if (/\bwarn(ing)?\b/i.test(text)) return "warn";
    return "";
  }

  function fetchLog(dispatchId, swarmId) {
    if (!dispatchId) return Promise.resolve({ title: "Log", lines: [] });
    var q = new URLSearchParams({
      swarm: swarmId || (state && state.swarmId) || "",
      dispatch: dispatchId,
      format: "structured",
      lines: "80",
    });
    return fetch("/api/log-tail?" + q.toString(), { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("log " + res.status);
        return res.json();
      })
      .then(function (data) {
        var items = data.events || data.lines || [];
        /* Content based freshness. The tail window shifts every refresh, so index
           math would re-animate old lines. Compare text against the last fetch. */
        var prev = logPrevSets[dispatchId] || null;
        var texts = [];
        var lines = [];
        for (var i = 0; i < items.length; i++) {
          var ev = items[i];
          var text = eventText(ev);
          if (!text || !String(text).trim()) continue; /* skip empty crumbs */
          texts.push(text);
          lines.push({
            text: text,
            cls: eventClass(ev, text),
            fresh: !!prev && !prev.has(text),
          });
        }
        logPrevSets[dispatchId] = new Set(texts);
        return { title: "Log " + (data.dispatchId || dispatchId), lines: lines };
      });
  }

  /* ---------- init ---------- */

  function init() {
    if (started) return;
    started = true;
    // Prefer ?swarm= deep-link, then localStorage pref, then registry.default (in loadRegistry).
    var qs = "";
    try {
      qs = new URLSearchParams(window.location.search || "").get("swarm") || "";
    } catch (e) {
      qs = "";
    }
    if (qs) {
      selectedSwarm = qs;
      prefSet("swarm", selectedSwarm);
    } else {
      selectedSwarm = prefGet("swarm", "") || "";
    }
    function wake() {
      /* Mobile Safari / iOS: timers freeze in background; always force a fetch on wake. */
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      poll(true);
    }
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = null;
      } else {
        wake();
      }
    });
    /* bfcache restore (iOS back/forward) + laptop lid open */
    window.addEventListener("pageshow", function (ev) {
      if (ev && ev.persisted) wake();
    });
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    loadRegistry().then(function () {
      // If pref points at a removed swarm, fall back to registry.default (single-swarm view).
      if (selectedSwarm && selectedSwarm !== "overview" && selectedSwarm !== "__all__") {
        var known = (registry.swarms || []).some(function (s) {
          return s.id === selectedSwarm;
        });
        if (!known) {
          selectedSwarm = registry.default || "";
          prefSet("swarm", selectedSwarm);
        }
      }
      poll(true);
    });
  }

  var SwarmStore = {
    init: init,
    on: on,
    selectSwarm: selectSwarm,
    fetchLog: fetchLog,
    refresh: function () {
      return poll(true);
    },
    prefs: prefs,
    history: history,
    relTime: relTime,
    fmtDur: fmtDur,
    esc: esc,
    /* Expose for diagnostics / tests that drive the live store path. */
    structureKey: structureKey,
  };

  Object.defineProperty(SwarmStore, "lastUpdatedAt", {
    get: function () {
      return lastUpdatedAt || (state && state.updatedAt) || 0;
    },
  });
  Object.defineProperty(SwarmStore, "failures", {
    get: function () {
      return failures;
    },
  });

  Object.defineProperty(SwarmStore, "state", {
    get: function () {
      return state;
    },
  });
  Object.defineProperty(SwarmStore, "registry", {
    get: function () {
      return registry;
    },
  });
  Object.defineProperty(SwarmStore, "selectedSwarm", {
    get: function () {
      return selectedSwarm;
    },
  });
  /* pollIntervalMs returns 0 while the tab is hidden (paused). Report the
     cadence that will resume instead, so the footer never shows "poll 0s". */
  Object.defineProperty(SwarmStore, "pollMs", {
    get: function () {
      return pollIntervalMs(state) || 2000;
    },
  });

  window.SwarmStore = SwarmStore;
})();
