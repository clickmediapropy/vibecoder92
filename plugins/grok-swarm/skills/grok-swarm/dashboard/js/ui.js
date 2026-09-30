/**
 * Mission Control renderers + wiring.
 * Consumes window.SwarmStore for data and window.MissionEngine for the field.
 * Every engine call is guarded: the UI must stay fully usable when GL fails.
 */
(function () {
  "use strict";

  var store = window.SwarmStore;
  if (!store) {
    console.warn("SwarmStore missing, dashboard cannot render");
    return;
  }

  var esc = store.esc;
  var fmtDur = store.fmtDur;
  var relTime = store.relTime;
  var boardCol = window.SwarmBoardColumn;
  var mobModel = window.SwarmMobileModel;

  function $(id) {
    return document.getElementById(id);
  }

  var field = null;
  var lastState = null;
  var viewMode = (function () {
    var v = store.prefs.get("view", "kanban");
    if (v === "timeline" || v === "guide") return v;
    return "kanban";
  })();
  /* Phone bottom-nav regions (Guide is a viewMode, not a region). */
  var MOBILE_VIEWS = ["board", "mission", "ops", "chat"];
  var mobileView = store.prefs.get("mview", "board");
  if (MOBILE_VIEWS.indexOf(mobileView) < 0) mobileView = "board";
  /* Phone chrome state: coordinator liveness comes from /api/mail, the board
     column the operator picked, the pending control action, chat unread. */
  var coordAlive = null;
  var userBoardCol = store.prefs.get("mcol", "");
  var pendingCtl = null;
  var confirmPauseUntil = 0;
  var confirmPauseTimer = null;
  var lastMail = [];
  var selectedDispatch = null;
  var selectedDispatchSwarm = "";
  var flashMarks = {};
  var lastStatValues = {};
  var lastActivityTs = 0;
  var etaTargetTs = 0;
  var etaTicker = null;
  var runTicker = null;
  var logTimer = null;
  var stickLogBottom = true;
  var offline = false;
  /* Open task popover id — re-anchor after hard board rebuild. */
  var openTaskPopId = null;
  var openRunPopId = null;
  /* Scroll containers restored across hard renders (soft path never touches them). */
  var SCROLL_RESTORE_SEL =
    ".col-body, #kanban-view, #timeline-view, #guide-view, #rail-ops, #rail-mission, #live-runs, #log-body, #main-view";

  /* ---------- engine guards ---------- */

  function engineCall(method) {
    if (!field || !field.ok || typeof field[method] !== "function") return null;
    var args = Array.prototype.slice.call(arguments, 1);
    try {
      return field[method].apply(field, args);
    } catch (err) {
      console.warn("field." + method + " failed", err);
      return null;
    }
  }

  /* Phones get the static field: a continuous WebGL loop drains the battery of
     a device that sits in a pocket watching a swarm. Widening the viewport
     (rotate a tablet, resize a window) starts the live field; narrowing stops it. */
  function initFieldForViewport() {
    var fallback = $("field-fallback");
    var mq = typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 767px)") : null;
    function apply() {
      var narrow = !!(mq && mq.matches);
      if (narrow) {
        engineCall("stop");
        if (fallback) fallback.classList.add("is-on");
        return;
      }
      if (!field) {
        if (fallback) fallback.classList.remove("is-on");
        initField();
      } else if (field.ok && !field.reduced) {
        if (fallback) fallback.classList.remove("is-on");
        engineCall("resize");
        engineCall("start");
      }
    }
    apply();
    if (mq && typeof mq.addEventListener === "function") mq.addEventListener("change", apply);
  }

  function initField() {
    var canvas = $("gl-canvas");
    var fallback = $("field-fallback");
    function toFallback() {
      if (fallback) fallback.classList.add("is-on");
    }
    if (!canvas || typeof window.MissionEngine !== "function") {
      toFallback();
      return;
    }
    try {
      field = new window.MissionEngine(canvas);
    } catch (err) {
      console.warn("field engine failed to construct", err);
      field = null;
    }
    if (!field || !field.ok) {
      toFallback();
      return;
    }
    /* Reduced motion: the engine constructs fine but start() is a deliberate
       no-op, so the canvas would stay blank. Show the static field instead. */
    if (field.reduced) {
      toFallback();
      return;
    }
    engineCall("start");
    window.addEventListener("resize", function () {
      engineCall("resize");
    });
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) engineCall("stop");
      else if (!isNarrow()) engineCall("start");
    });
    if (typeof window.matchMedia === "function") {
      var mq = window.matchMedia("(prefers-color-scheme: dark)");
      if (mq && typeof mq.addEventListener === "function") {
        mq.addEventListener("change", function () {
          engineCall("refreshColors");
        });
      }
    }
  }

  /* ---------- opt in sonification, only behind the Cinema toggle ---------- */

  var audio = {
    ctx: null,
    master: null,
    filter: null,
    oscs: [],
    on: false,
    start: function () {
      if (this.on) return;
      try {
        var Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return;
        this.ctx = this.ctx || new Ctor();
        this.ctx.resume();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.035;
        this.filter = this.ctx.createBiquadFilter();
        this.filter.type = "lowpass";
        this.filter.frequency.value = 220;
        var self = this;
        var mk = function (freq, detune) {
          var o = self.ctx.createOscillator();
          o.type = "triangle";
          o.frequency.value = freq;
          o.detune.value = detune;
          o.connect(self.filter);
          o.start();
          return o;
        };
        this.oscs = [mk(55, 0), mk(110, 6)];
        this.filter.connect(this.master);
        this.master.connect(this.ctx.destination);
        this.on = true;
      } catch (err) {
        /* audio unavailable, silent by design */
      }
    },
    stop: function () {
      if (!this.on) return;
      try {
        this.oscs.forEach(function (o) {
          o.stop();
        });
        this.oscs = [];
        this.master.disconnect();
      } catch (err) {
        /* noop */
      }
      this.on = false;
    },
    setLive: function (n) {
      if (!this.on || !this.filter) return;
      try {
        this.filter.frequency.setTargetAtTime(
          160 + Math.min(12, n) * 110,
          this.ctx.currentTime,
          0.6,
        );
      } catch (err) {
        /* noop */
      }
    },
    chime: function () {
      if (!this.on || !this.ctx) return;
      try {
        var o = this.ctx.createOscillator();
        var g = this.ctx.createGain();
        o.type = "sine";
        o.frequency.setValueAtTime(880, this.ctx.currentTime);
        o.frequency.exponentialRampToValueAtTime(1318, this.ctx.currentTime + 0.18);
        g.gain.setValueAtTime(0.04, this.ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.7);
        o.connect(g);
        g.connect(this.ctx.destination);
        o.start();
        o.stop(this.ctx.currentTime + 0.75);
      } catch (err) {
        /* noop */
      }
    },
  };

  /* ---------- small helpers ---------- */

  function isNarrow() {
    return window.matchMedia("(max-width: 767px)").matches;
  }

  /* Status colors live in CSS (.pill.s-<status>), which uses the AA-tuned
     --*-ink text tokens. Never inline raw accent colors here: they fail
     contrast against the glass panel background. */
  var KNOWN_STATUS = {
    open: 1, assigned: 1, planning: 1, building: 1, running: 1,
    review: 1, paused: 1, done: 1, blocked: 1, failed: 1, killed: 1,
    cancelled: 1,
  };

  function statusPill(status) {
    var s = String(status || "");
    var mod = KNOWN_STATUS[s] ? " s-" + s : " mute";
    return '<span class="pill' + mod + '">' + esc(s) + "</span>";
  }

  function runByTaskId(s) {
    var map = {};
    (s.runningDispatches || []).forEach(function (r) {
      if (r && r.taskId) map[r.taskId] = r;
    });
    return map;
  }

  function friendly(t, byId, fs, run) {
    var live = run || t.liveDispatch;
    if (live && boardCol && typeof boardCol.liveFriendly === "function") {
      var liveCol = boardCol.liveColumnForRole(boardCol.roleFromAgentLabel(live.agentLabel));
      if (liveCol) return boardCol.liveFriendly(live);
    }
    if (fs && fs[t.id]) return fs[t.id];
    var who = t.ownerAgentLabel || "someone";
    switch (t.status) {
      case "done":
        return "Done";
      case "building":
        return who + " is building";
      case "planning":
        return who + " is planning";
      case "review":
        return "Ready for review";
      case "blocked":
        return "Blocked: " + (t.blockedReason || "needs help");
      case "assigned": {
        var waiting = (t.dependsOn || []).filter(function (d) {
          var dep = byId.get(d);
          return !dep || dep.status !== "done";
        });
        return waiting.length ? "Waiting on " + waiting.join(", ") : "Queued for " + who;
      }
      default:
        return "Waiting to be picked up";
    }
  }

  function shortSwarm(id, title) {
    if (!id) return "";
    var m = String(id).match(/iss-([\w-]+)$/);
    if (m) return "#" + m[1].replace(/-/g, "/");
    if (title && title.length < 28) return title;
    return String(id).slice(-24);
  }

  function vtName(id) {
    return "t-" + String(id || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  function liveCount(s) {
    var st = s.stats || {};
    return (s.runningDispatches || []).length || st.runningDispatches || 0;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () {
        fallbackCopy(text);
      });
    } else fallbackCopy(text);
  }

  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("aria-hidden", "true");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (err) {
      /* clipboard blocked */
    }
    document.body.removeChild(ta);
  }

  function flashTask(id) {
    var card = document.querySelector('.card[data-task="' + cssEscape(id) + '"]');
    if (!card) return false;
    /* Phone board shows one column: switch to the card's column first. */
    var colEl = isNarrow() && card.closest ? card.closest(".col[data-col]") : null;
    if (colEl) {
      userBoardCol = colEl.getAttribute("data-col");
      setBoardCol(userBoardCol);
    }
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.add("flash-target");
    setTimeout(function () {
      card.classList.remove("flash-target");
    }, 1600);
    return true;
  }

  function cssEscape(v) {
    var s = String(v);
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(s);
    return s.replace(/["\\]/g, "\\$&");
  }

  /* ---------- header ---------- */

  function renderHeader(s) {
    var sid = s.swarmId === "overview" ? "all packs" : s.swarmId;
    var sub = $("subtitle");
    if (sub) sub.textContent = [s.repoName, sid].filter(Boolean).join(" / ") || "-";
    var goal = $("goal-title");
    if (goal) goal.textContent = s.goal && s.goal.title ? s.goal.title : "No goal set";
    var dot = $("dot");
    var label = $("dot-label");
    if (dot && !offline) {
      dot.classList.toggle("live", liveCount(s) > 0);
      dot.classList.remove("stale");
    }
    if (label && !offline) {
      var st0 = s.stats || {};
      var phase0 = st0.phase || (liveCount(s) > 0 ? "live" : "idle");
      // Never show bare "Idle" while work sits in Review (coordinator lag) — that lied to operators.
      if (phase0 === "live") label.textContent = "Live";
      else if (phase0 === "coord-lag") label.textContent = "Coord lag";
      else if (phase0 === "review") label.textContent = "Review";
      else if (phase0 === "done") label.textContent = "Done";
      else label.textContent = "Idle";
    }
  }

  /* ---------- stats ---------- */

  function sparkHtml(label) {
    var hist = (store.history && store.history[label]) || [];
    if (hist.length <= 2) return "";
    var max = Math.max.apply(null, hist.concat([1]));
    var pts = hist
      .map(function (v, i) {
        var x = (i / (hist.length - 1)) * 100;
        var y = 100 - (v / max) * 100;
        return x.toFixed(1) + "% " + y.toFixed(1) + "%";
      })
      .join(",");
    return '<i class="spark" style="clip-path:polygon(0% 100%,' + pts + ',100% 100%)"></i>';
  }

  function renderStats(s) {
    var host = $("stats");
    if (!host) return;
    var st = s.stats || {};
    var c = st.counts || {};
    var rows = [
      ["Live", liveCount(s)],
      ["Building", c.building || 0],
      ["Blocked", c.blocked || 0],
      ["Review", c.review || 0],
      ["Queued", (c.open || 0) + (c.assigned || 0)],
      ["Done", st.done || 0],
      ["Total", st.total || 0],
    ];
    var readyCount = Number(st.readyCount || 0);
    host.classList.remove("is-loading");
    var existing = host.querySelectorAll(".stat");
    var canPatch = existing.length === rows.length;
    if (canPatch) {
      for (var i = 0; i < rows.length; i++) {
        var label = rows[i][0];
        var val = rows[i][1];
        var el = existing[i];
        var changed = lastStatValues[label] !== undefined && lastStatValues[label] !== val;
        lastStatValues[label] = val;
        var hot = (label === "Blocked" || label === "Live") && val > 0;
        el.classList.toggle("hot", hot);
        el.classList.toggle("tick", changed);
        var b = el.querySelector("b");
        if (b) {
          b.textContent = String(val);
          b.style.color =
            label === "Blocked" && val > 0
              ? "var(--red-ink)"
              : label === "Live" && val > 0
                ? "var(--blue-ink)"
                : "";
        }
        var spark = el.querySelector(".spark");
        var sparkNext = sparkHtml(label);
        if (spark && sparkNext) {
          spark.setAttribute("style", sparkNext.match(/style="([^"]*)"/)[1]);
        } else if (!spark && sparkNext) {
          el.insertAdjacentHTML("afterbegin", sparkNext);
        }
        var chip = el.querySelector(".ready-chip");
        if (label === "Queued" && readyCount > 0) {
          if (chip) chip.textContent = readyCount + " ready";
          else el.insertAdjacentHTML("beforeend", '<span class="ready-chip">' + readyCount + " ready</span>");
        } else if (chip) {
          chip.remove();
        }
      }
      return;
    }
    host.innerHTML = rows
      .map(function (row) {
        var label = row[0];
        var val = row[1];
        var hot = (label === "Blocked" || label === "Live") && val > 0;
        var changed = lastStatValues[label] !== undefined && lastStatValues[label] !== val;
        lastStatValues[label] = val;
        var tone =
          label === "Blocked" && val > 0
            ? "color:var(--red-ink)"
            : label === "Live" && val > 0
              ? "color:var(--blue-ink)"
              : "";
        var chip =
          label === "Queued" && readyCount > 0
            ? '<span class="ready-chip">' + readyCount + " ready</span>"
            : "";
        return (
          '<div class="stat' +
          (hot ? " hot" : "") +
          (changed ? " tick" : "") +
          '">' +
          sparkHtml(label) +
          '<b style="' +
          tone +
          '">' +
          val +
          "</b><span>" +
          label +
          "</span>" +
          chip +
          "</div>"
        );
      })
      .join("");
  }

  /* ---------- mission panel ---------- */

  function updateEtaSub() {
    var sub = $("eta-sub");
    if (!sub) return;
    if (!etaTargetTs) {
      sub.textContent = "progress";
      return;
    }
    var left = etaTargetTs - Date.now();
    sub.textContent = left > 0 ? "eta ~" + fmtDur(left) : "eta now";
  }

  function renderMission(s) {
    var st = s.stats || {};
    var pct = Number(st.pct || 0);
    document.documentElement.style.setProperty("--progress", pct + "%");

    var pctEl = $("eta-pct");
    if (pctEl) pctEl.textContent = pct + "%";

    var bar = $("bar");
    if (bar) {
      bar.style.width = pct + "%";
      bar.classList.toggle("done", pct === 100 && (st.total || 0) > 0);
    }

    var count = $("mission-count");
    if (count) {
      count.textContent = st.total ? (st.done || 0) + " / " + st.total : "No tracked tasks";
    }

    var etaEl = $("mission-eta");
    if (etaEl) {
      if (s.eta && s.eta.medianTaskMs) {
        etaEl.hidden = false;
        etaEl.textContent =
          "median " +
          fmtDur(s.eta.medianTaskMs) +
          " per task, " +
          (s.eta.remainingTasks || 0) +
          " left";
      } else {
        etaEl.hidden = true;
        etaEl.textContent = "";
      }
    }

    var etaActive = !!(s.eta && s.eta.estimatedMsLeft && pct < 100);
    /* Soft polls must not re-base the countdown every 2s (visible jump).
       Only re-anchor when first activating or when server estimate drifts > 5s. */
    if (etaActive) {
      var nextTarget = Date.now() + s.eta.estimatedMsLeft;
      if (!etaTargetTs || Math.abs(nextTarget - etaTargetTs) > 5000) {
        etaTargetTs = nextTarget;
      }
    } else {
      etaTargetTs = 0;
    }
    updateEtaSub();
    if (etaActive && !etaTicker) etaTicker = setInterval(updateEtaSub, 1000);
    if (!etaActive && etaTicker) {
      clearInterval(etaTicker);
      etaTicker = null;
    }

    var celeb = $("celebrate");
    if (celeb) {
      var complete = !!(st.total && st.done === st.total);
      celeb.hidden = !complete;
      if (complete) celeb.textContent = "All tracked tasks done";
    }
  }

  /* ---------- host memory ---------- */

  function renderMemory(s) {
    var panel = $("mem-banner");
    if (!panel) return;
    var hm = s.hostMemory;
    if (!hm || hm.totalGb == null) {
      panel.hidden = false;
      panel.className = "panel mem-panel mem-warn";
      if ($("mem-label")) $("mem-label").textContent = "Host RAM";
      if ($("mem-pct")) $("mem-pct").textContent = "-";
      if ($("mem-detail")) $("mem-detail").textContent = "Waiting for host metrics";
      return;
    }
    var thr = hm.minFreeGb != null ? hm.minFreeGb : 2;
    var low = !!hm.low || hm.availableGb < thr;
    var warn = !low && hm.availableGb < thr * 1.5;
    var paused = !!(hm.autoPaused || (s.memoryGuard && s.memoryGuard.triggered));
    panel.hidden = false;
    panel.className = "panel mem-panel " + (low ? "mem-crit" : warn ? "mem-warn" : "mem-ok");
    if ($("mem-label")) {
      $("mem-label").textContent =
        (low ? "Low RAM, auto-pause may fire" : "Host RAM") + (paused ? " AUTO-PAUSED" : "");
    }
    var pctUsed = Math.min(100, Number(hm.pctUsed) || 0);
    if ($("mem-pct")) $("mem-pct").textContent = (hm.pctUsed != null ? hm.pctUsed : "?") + "% used";
    if ($("mem-detail")) {
      $("mem-detail").textContent =
        hm.line ||
        "used " +
          hm.usedGb +
          " / " +
          hm.totalGb +
          " G, available " +
          hm.availableGb +
          " G, kill if avail below " +
          thr +
          " G";
    }
    document.documentElement.style.setProperty("--ram", pctUsed + "%");
    var barEl = $("mem-bar");
    if (barEl) {
      barEl.style.width = pctUsed + "%";
      barEl.className = "mem-bar-inner" + (low ? " crit" : warn ? " warn" : "");
    }
  }

  /* ---------- board health ---------- */

  function renderHealth(s) {
    var panel = $("health-panel");
    var list = $("health-list");
    if (!panel || !list) return;
    var h = s.boardHealth;
    var problems = (h && h.problems) || [];
    if (!h || h.ok || !problems.length) {
      panel.hidden = true;
      list.innerHTML = "";
      return;
    }
    panel.hidden = false;
    list.innerHTML = problems
      .map(function (p) {
        var ids = (p.tasks || [])
          .map(function (id) {
            return '<a class="task-link" href="#" data-goto="' + esc(id) + '">' + esc(id) + "</a>";
          })
          .join(" ");
        return (
          '<div class="health-row">' +
          '<span class="kind-badge ' +
          esc(p.kind || "issue") +
          '">' +
          esc(p.kind || "issue") +
          "</span>" +
          '<span class="health-msg">' +
          esc(p.message || "Board problem") +
          "</span>" +
          (ids ? '<span class="health-tasks">' + ids + "</span>" : "") +
          "</div>"
        );
      })
      .join("");
  }

  /* ---------- operator control plane ---------- */
  function apiPost(route, body) {
    var sw = (window.SwarmStore && window.SwarmStore.selectedSwarm) || "";
    if (sw && sw !== "overview" && sw !== "__all__") body.swarm = sw;
    return fetch(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); });
  }
  function showChatError(msg) {
    var el = $("chat-error");
    if (!el) return;
    el.hidden = !msg;
    el.textContent = msg || "";
  }

  /* Phone feedback strip above the bottom nav. Errors stay until dismissed. */
  var toastTimer = null;
  function showToast(msg, tone) {
    var el = $("toast");
    if (!el || !isNarrow()) return;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = null;
    if (!msg) {
      el.hidden = true;
      return;
    }
    $("toast-msg").textContent = msg;
    el.setAttribute("data-tone", tone || "");
    el.hidden = false;
    if (tone !== "bad") {
      toastTimer = setTimeout(function () {
        el.hidden = true;
      }, 4000);
    }
  }

  function apiError(r) {
    return ((r && (r.stderr || r.error || r.stdout)) || "").trim().slice(0, 600);
  }

  var CTL_DONE = {
    hold: "On hold. Running builders finish, nothing new starts.",
    pause: "Paused. Builders stopped, state kept.",
    resume: "Resumed. Coordinator is restarting.",
  };

  function ctlButtons() {
    return ["hold", "pause", "resume"].map(function (a) {
      return $("ctl-" + a);
    });
  }

  function clearPauseConfirm() {
    confirmPauseUntil = 0;
    if (confirmPauseTimer) clearTimeout(confirmPauseTimer);
    confirmPauseTimer = null;
    var b = $("ctl-pause");
    if (b) {
      b.classList.remove("is-confirm");
      b.textContent = "Pause";
    }
  }

  function controlAction(action, btn) {
    /* Pause tree-kills builders. On a phone it takes a second tap within 3s. */
    if (action === "pause" && isNarrow() && Date.now() > confirmPauseUntil) {
      confirmPauseUntil = Date.now() + 3000;
      btn.classList.add("is-confirm");
      btn.textContent = "Tap to confirm";
      confirmPauseTimer = setTimeout(clearPauseConfirm, 3000);
      return;
    }
    clearPauseConfirm();
    pendingCtl = action;
    ctlButtons().forEach(function (b) {
      if (b) b.disabled = true;
    });
    btn.setAttribute("aria-busy", "true");
    showChatError("");
    showToast("");
    function done() {
      pendingCtl = null;
      btn.removeAttribute("aria-busy");
      if (lastState) renderPause(lastState);
    }
    apiPost("/api/control", { action: action }).then(function (r) {
      if (!r.ok) {
        showChatError(action + " failed: " + apiError(r));
        showToast(action.charAt(0).toUpperCase() + action.slice(1) + " failed: " + (apiError(r) || "no output"), "bad");
      } else {
        showToast(CTL_DONE[action] || "Done", "ok");
      }
      done();
      if (window.SwarmStore && window.SwarmStore.refresh) window.SwarmStore.refresh();
      loadChat();
    }).catch(function (e) {
      showChatError(String(e));
      showToast(String(e), "bad");
      done();
    });
  }

  /* Command bar (phone): capsule + which controls apply. Desktop only reads
     the disabled state renderPause already sets. */
  function renderCommand() {
    if (!mobModel || !lastState) return;
    var ts = Number(lastState.updatedAt || store.lastUpdatedAt || Date.now());
    var cs = mobModel.commandState(lastState.paused, coordAlive, offline ? 1e9 : Date.now() - ts);
    var cap = $("mob-state");
    if (cap) {
      cap.setAttribute("data-tone", cs.tone);
      cap.setAttribute("aria-label", "Swarm " + cs.label + (cs.hint ? ": " + cs.hint : ""));
      $("mob-state-label").textContent = cs.label;
      var stale = $("mob-state-stale");
      stale.hidden = !cs.stale;
      stale.textContent = cs.stale ? (offline ? "offline" : "stale " + fmtStale(cs.stale)) : "";
    }
    ["hold", "pause", "resume"].forEach(function (a) {
      var b = $("ctl-" + a);
      if (!b) return;
      var st = cs.buttons[a];
      b.setAttribute("data-avail", st.enabled ? "1" : "0");
      b.classList.toggle("is-primary", !!st.primary);
    });
  }

  function fmtStale(sec) {
    return sec < 120 ? sec + "s" : Math.floor(sec / 60) + "m";
  }

  function pauseSummary() {
    var s = lastState;
    if (!s) return "";
    var p = s.paused;
    if (!p) {
      if (coordAlive === false) return "Coordinator is not running. Messages queue until it starts.";
      return "Live. Hold stops new dispatches; Pause also stops running builders.";
    }
    var n = (p.interrupted || []).length;
    return (
      (p.noKill ? "On hold" : "Paused") +
      (p.reason ? ": " + p.reason : "") +
      (p.pausedAt ? ", since " + new Date(p.pausedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "") +
      (n ? ", " + n + " interrupted run" + (n === 1 ? "" : "s") : "")
    );
  }

  /* ---------- chat ---------- */

  function chatSeenTs() {
    return Number(store.prefs.get("chatSeen", "0")) || 0;
  }

  function markChatSeen() {
    var newest = 0;
    lastMail.forEach(function (m) {
      var t = typeof m.timestamp === "number" ? m.timestamp : Date.parse(m.timestamp) || 0;
      if (t > newest) newest = t;
    });
    if (newest > chatSeenTs()) store.prefs.set("chatSeen", String(newest));
    updateMobBadge("mob-badge-chat", 0, "");
  }

  function onChatTab() {
    return isNarrow() && mobileView === "chat" && viewMode !== "guide";
  }

  function fmtClock(t) {
    return new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function sepLabel(t) {
    var d = new Date(t);
    var today = new Date();
    var y = new Date(today.getTime() - 86400000);
    var day =
      d.toDateString() === today.toDateString()
        ? "Today"
        : d.toDateString() === y.toDateString()
          ? "Yesterday"
          : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    return day + " · " + fmtClock(t);
  }

  var chatSeen = "";
  function loadChat() {
    var sw = (window.SwarmStore && window.SwarmStore.selectedSwarm) || "";
    var q = sw && sw !== "overview" && sw !== "__all__" ? "?swarm=" + encodeURIComponent(sw) : "";
    var list = $("chat-list"), status = $("chat-status");
    if (!list) return;
    fetch("/api/mail" + q, { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (d) {
      coordAlive = !!d.coordinatorAlive;
      renderCommand();
      if (status) {
        var txt = d.paused ? (d.paused.noKill ? "on hold" : "paused") : (d.coordinatorAlive ? "live" : "coordinator offline — messages queue until Resume");
        /* Phone header is one line and the command bar already says why. */
        if (isNarrow() && !d.coordinatorAlive && !d.paused) txt = "offline · messages queue";
        status.textContent = txt;
        status.className = "chat-status" + (d.coordinatorAlive && !d.paused ? " live" : "");
      }
      var messages = d.messages || [];
      lastMail = messages;
      /* Unread badge runs every poll, before the no-change early return. */
      if (onChatTab()) markChatSeen();
      else if (mobModel) {
        var u = mobModel.unreadCount(messages, chatSeenTs());
        updateMobBadge("mob-badge-chat", u.n, u.alert ? "alert" : "");
      }
      var key = messages.map(function (m) { return m.id; }).join(",");
      if (key === chatSeen) return;
      chatSeen = key;
      var nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      var narrow = isNarrow();
      var rows = mobModel ? mobModel.groupMessages(messages) : messages.map(function (m) {
        return { sep: false, kind: m.from === "Operator" ? "me" : m.type === "message" ? "them" : "notice", cont: false, msg: m, ts: Date.parse(m.timestamp) || m.timestamp || 0 };
      });
      list.innerHTML = rows.length
        ? rows.map(function (row) {
            if (row.sep) return '<div class="chat-sep">' + esc(sepLabel(row.ts)) + "</div>";
            var m = row.msg;
            var cls = (row.kind === "me" ? "me" : row.kind === "notice" ? "sys" : "") +
              " k-" + row.kind + (row.cont ? " cont" : "") + " t-" + esc(m.type || "message");
            return '<div class="chat-msg ' + cls + '"><b>' + esc(m.from) + (m.to === "@all" ? " → all" : "") + "</b><br>" +
              esc(m.body || "") + "<time>" + (narrow ? fmtClock(row.ts) : new Date(m.timestamp || 0).toLocaleTimeString()) + "</time></div>";
          }).join("")
        : '<div class="chat-empty">No messages yet. Ask the coordinator for a status report, or steer it here.</div>';
      if (nearBottom || !narrow) list.scrollTop = list.scrollHeight;
    }).catch(function () { /* keep last render */ });
  }

  function sendChat(text) {
    var input = $("chat-input");
    return apiPost("/api/mail", { body: text }).then(function (r) {
      if (!r.ok) {
        var msg = "send failed: " + (r.stderr || r.error || "").slice(0, 400);
        showChatError(msg);
        showToast("Message not sent: " + (apiError(r) || "no output"), "bad");
        return false;
      }
      showChatError("");
      loadChat();
      var list = $("chat-list");
      if (list) setTimeout(function () { list.scrollTop = list.scrollHeight; }, 400);
      return true;
    }).catch(function (err) {
      showChatError(String(err));
      showToast("Message not sent: " + String(err), "bad");
      return false;
    });
  }

  function fitComposer() {
    var input = $("chat-input");
    if (!input || !isNarrow()) return;
    input.rows = 1;
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight + 2, 132) + "px";
    var send = document.querySelector("#chat-form .chat-send");
    if (send) send.disabled = !input.value.trim();
  }

  function setTaskSheet(open) {
    var sheet = $("task-sheet");
    if (!sheet) return;
    sheet.open = !!open;
    if (open) showToast("");
    var add = $("chat-add");
    if (add) add.setAttribute("aria-expanded", open ? "true" : "false");
    if (open && isNarrow()) {
      var title = $("task-title");
      if (title) setTimeout(function () { title.focus(); }, 60);
    }
  }

  /* ---------- pause + resume ---------- */

  function renderPause(s) {
    var banner = $("pause-banner");
    var panel = $("resume-panel");
    var list = $("resume-list");
    var hold = $("ctl-hold"), pause = $("ctl-pause"), resume = $("ctl-resume");
    renderCommand();
    /* While a control request is in flight its buttons stay locked. */
    if (hold && pause && resume && !pendingCtl) {
      var p = s.paused;
      hold.disabled = !!p;
      pause.disabled = !!(p && !p.noKill);
      resume.disabled = !p;
      hold.setAttribute("aria-pressed", p && p.noKill ? "true" : "false");
      pause.setAttribute("aria-pressed", p && !p.noKill ? "true" : "false");
    }
    if (banner) {
      if (!s.paused) {
        banner.hidden = true;
      } else {
        var n = (s.paused.interrupted || []).length;
        banner.hidden = false;
        banner.textContent =
          "Paused" +
          (s.paused.reason ? ": " + s.paused.reason : "") +
          (s.paused.pausedAt ? " since " + new Date(s.paused.pausedAt).toLocaleString() : "") +
          (n ? ", " + n + " interrupted run" + (n === 1 ? "" : "s") : "");
      }
    }
    if (!panel || !list) return;
    var plan = s.paused ? s.resumePlan || [] : [];
    if (!plan.length) {
      panel.hidden = true;
      list.innerHTML = "";
      return;
    }
    panel.hidden = false;
    list.innerHTML = plan
      .map(function (r, i) {
        return (
          '<div class="resume-row">' +
          '<div class="resume-head"><b>' +
          esc(r.agentLabel || "agent") +
          '</b><span class="resume-title">' +
          esc(r.taskTitle || r.taskId || "") +
          "</span>" +
          (r.taskStatus ? statusPill(r.taskStatus) : "") +
          "</div>" +
          '<pre class="resume-cmd" id="resume-cmd-' +
          i +
          '">' +
          esc(r.resumeCommand || "") +
          "</pre>" +
          '<button type="button" class="btn resume-copy" data-copy="' +
          i +
          '">Copy</button>' +
          "</div>"
        );
      })
      .join("");
  }

  /* ---------- board ---------- */

  function taskCard(t, byId, s, runningIds, run) {
    var live = run || t.liveDispatch;
    var fm = flashMarks[t.id];
    var flash = fm && fm.until > Date.now() ? " " + fm.cls : "";
    var pack =
      s.swarmId === "overview" && t.swarmId
        ? '<span class="pill pill-pack">' + esc(shortSwarm(t.swarmId, t.swarmTitle)) + "</span>"
        : "";
    var owner = (live && live.agentLabel) || t.ownerAgentLabel;
    /* Phone card chrome (hidden on desktop by core.css): owner avatar, and a
       live timer for running work. tickRunElapsed advances every [data-elapsed]. */
    var who =
      owner && mobModel
        ? '<span class="card-who" style="--who-h:' +
          mobModel.ownerHue(owner) +
          '" aria-hidden="true">' +
          esc(mobModel.initials(owner)) +
          "</span>"
        : "";
    var runMs = live && live.elapsedMs != null ? Number(live.elapsedMs) : null;
    var timer =
      runMs != null
        ? '<span class="card-timer" data-elapsed="' +
          runMs +
          '" data-at="' +
          Date.now() +
          '" title="Running for">' +
          esc(fmtDur(runMs)) +
          "</span>"
        : "";
    return (
      '<div class="card' +
      (live || runningIds.has(t.id) ? " building-glow" : "") +
      (t.status === "blocked" ? " blocked" : "") +
      flash +
      '" data-task="' +
      esc(t.id) +
      '" style="view-transition-name:' +
      vtName(t.id) +
      '">' +
      who +
      '<div class="title">' +
      esc(t.title) +
      "</div>" +
      '<div class="friendly">' +
      esc(friendly(t, byId, s.friendlyStatus, live)) +
      "</div>" +
      '<div class="pills">' +
      statusPill(t.status) +
      (owner ? '<span class="pill pill-owner">' + esc(owner) + "</span>" : "") +
      pack +
      timer +
      "</div></div>"
    );
  }

  /**
   * Map a task status into a board column. Unknown non-cancelled statuses land in
   * Queued so column counters and cards always come from the same task list
   * (never "stats say open but every column is Empty").
   * Live logger/reviewer/builder dispatches override via SwarmBoardColumn so a
   * `done` task still appears in Building while the logger runs.
   */
  function boardColumnForStatus(status) {
    if (boardCol && typeof boardCol.boardColumnForStatus === "function") {
      return boardCol.boardColumnForStatus(status);
    }
    var st = String(status || "");
    if (st === "open" || st === "assigned") return "Queued";
    if (st === "planning" || st === "building") return "Building";
    if (st === "review") return "Review";
    if (st === "blocked") return "Blocked";
    if (st === "done") return "Done";
    if (st === "cancelled") return null;
    return "Queued";
  }

  function boardTasks(s) {
    return (s.tasks || []).filter(function (t) {
      return boardColumnForStatus(t.status) !== null;
    });
  }

  function captureScroll() {
    var out = [];
    document.querySelectorAll(SCROLL_RESTORE_SEL).forEach(function (el, i) {
      if (!el || el.scrollTop === 0 && el.scrollLeft === 0) return;
      out.push({
        i: i,
        id: el.id || "",
        col: el.closest && el.closest("[data-col]")
          ? el.closest("[data-col]").getAttribute("data-col")
          : "",
        top: el.scrollTop,
        left: el.scrollLeft,
        tag: el.tagName,
        cls: el.className || "",
      });
    });
    return out;
  }

  function restoreScroll(saved) {
    if (!saved || !saved.length) return;
    var nodes = document.querySelectorAll(SCROLL_RESTORE_SEL);
    saved.forEach(function (rec) {
      var el = null;
      if (rec.col) {
        var col = document.querySelector('.col[data-col="' + cssEscape(rec.col) + '"] .col-body');
        if (col) el = col;
      }
      if (!el && rec.id) el = document.getElementById(rec.id);
      if (!el && nodes[rec.i]) el = nodes[rec.i];
      if (!el) return;
      el.scrollTop = rec.top;
      el.scrollLeft = rec.left;
    });
  }

  function renderKanban(s) {
    var host = $("kanban-view");
    if (!host) return;
    var tasks = boardTasks(s);
    var byId = new Map(
      tasks.map(function (t) {
        return [t.id, t];
      }),
    );
    var runningIds = new Set(
      (s.runningDispatches || []).map(function (r) {
        return r.taskId;
      }),
    );
    var liveByTask = runByTaskId(s);
    var buckets =
      boardCol && typeof boardCol.bucketTasks === "function"
        ? boardCol.bucketTasks(tasks, s.runningDispatches || [])
        : {
            Queued: [],
            Building: [],
            Review: [],
            Blocked: [],
            Done: [],
          };
    if (!boardCol || typeof boardCol.bucketTasks !== "function") {
      tasks.forEach(function (t) {
        var col = boardColumnForStatus(t.status);
        if (col && buckets[col]) buckets[col].push(t);
      });
    }
    var cols = [
      ["Queued", buckets.Queued],
      ["Building", buckets.Building],
      ["Review", buckets.Review],
      ["Blocked", buckets.Blocked],
      ["Done", buckets.Done],
    ];
    var filled = cols.filter(function (col) {
      return col[1].length > 0;
    });
    var use = cols;
    if (isNarrow() && filled.length) use = filled;
    /* .col.is-empty is display:none on mobile. Never tag columns when the whole
       board is empty, or the board would render as nothing at all. */
    var tagEmpty = filled.length > 0;
    if (!filled.length) {
      host.innerHTML = '<div class="empty">No open tasks on this board</div>';
      return;
    }
    host.innerHTML = use
      .map(function (col) {
        var name = col[0];
        var list = col[1];
        /* .col-body is the scroll container the column height budget assumes.
           Without it, long columns overflow instead of scrolling. */
        return (
          '<div class="col col-' +
          name.toLowerCase() +
          (!list.length && tagEmpty ? " is-empty" : "") +
          '" data-col="' +
          esc(name) +
          '"><h3><span>' +
          esc(name) +
          '</span><span class="col-count">' +
          list.length +
          '</span></h3><div class="col-body">' +
          (list.length
            ? list
                .map(function (t) {
                  return taskCard(t, byId, s, runningIds, liveByTask[t.id] || t.liveDispatch);
                })
                .join("")
            : '<div class="empty">Empty</div>') +
          "</div></div>"
        );
      })
      .join("");
  }

  function renderTimeline(s) {
    var host = $("timeline-view");
    if (!host) return;
    var tasks = boardTasks(s)
      .slice()
      .sort(function (a, b) {
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
    var byId = new Map(
      tasks.map(function (t) {
        return [t.id, t];
      }),
    );
    host.innerHTML = tasks.length
      ? tasks
          .map(function (t) {
            return (
              '<div class="card" data-task="' +
              esc(t.id) +
              '"><div class="title">' +
              esc(t.title) +
              '</div><div class="friendly">' +
              esc(friendly(t, byId, s.friendlyStatus)) +
              '</div><div class="pills">' +
              statusPill(t.status) +
              '<span class="tl-time">' +
              esc(relTime(t.updatedAt) || "no updates") +
              "</span></div></div>"
            );
          })
          .join("")
      : '<div class="empty">No tasks</div>';
  }

  function renderMain(s) {
    if (viewMode === "guide") renderGuide(s);
    else if (viewMode === "timeline") renderTimeline(s);
    else renderKanban(s);
  }

  function daemonPill(label, rec) {
    var alive = !!(rec && rec.alive);
    var extra = "";
    if (alive && rec.pid) extra += " pid " + rec.pid;
    if (alive && rec.port) extra += " :" + rec.port;
    if (alive && rec.sessionId) extra += " sess " + String(rec.sessionId).slice(0, 8);
    return (
      '<span class="daemon-pill ' +
      (alive ? "on" : "off") +
      '"><b>' +
      esc(label) +
      "</b> " +
      (alive ? "up" : "down") +
      esc(extra) +
      "</span>"
    );
  }

  function pathBase(p) {
    if (!p) return "";
    var s = String(p);
    var i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function kvRow(k, v) {
    if (v === null || v === undefined || v === "") return "";
    return (
      '<div class="kv-row"><span class="kv-k">' +
      esc(k) +
      '</span><code class="kv-v" data-copy="' +
      esc(String(v)) +
      '">' +
      esc(String(v)) +
      "</code></div>"
    );
  }

  function renderGuide(s) {
    var el = $("guide-view");
    if (!el) return;
    var op = s.operator || {};
    var paths = op.paths || {};
    var daemons = op.daemons || {};
    var st = s.stats || {};
    var c = st.counts || {};
    var sections = op.sections || [];
    var roles = op.roleMatrix || [];
    var tasks = op.taskDetails || s.tasks || [];
    var runs = op.dispatchDetails || s.dispatchHistory || [];

    var html = "";
    html += '<section class="guide-block">';
    html += "<h2>Swarm snapshot</h2>";
    html += '<div class="daemon-row">';
    html += daemonPill("Coordinator", daemons.coordinator);
    html += daemonPill("Healer", daemons.healer);
    html += daemonPill("Dashboard", daemons.dashboard);
    html += "</div>";
    html += '<div class="kv-grid">';
    html += kvRow("Repo", s.repoName || pathBase(paths.repoRoot || s.repoRoot));
    html += kvRow("Repo path", paths.repoRoot || s.repoRoot);
    html += kvRow("Swarm id", s.swarmId);
    html += kvRow("Workspace", paths.workspace || s.workspace);
    html += kvRow("Goal", s.goal && s.goal.title);
    html += kvRow(
      "Progress",
      (st.done || 0) +
        "/" +
        (st.total || 0) +
        " (" +
        (st.pct || 0) +
        "%) · live " +
        liveCount(s) +
        " · ready " +
        (st.readyCount || 0),
    );
    html += kvRow(
      "Counts",
      "open " +
        (c.open || 0) +
        " · assigned " +
        (c.assigned || 0) +
        " · building " +
        (c.building || 0) +
        " · review " +
        (c.review || 0) +
        " · blocked " +
        (c.blocked || 0) +
        " · done " +
        (c.done || 0),
    );
    if (s.paused) html += kvRow("Paused", s.paused.reason || "yes");
    if (daemons.dashboard && daemons.dashboard.url) html += kvRow("Dashboard URL", daemons.dashboard.url);
    if (paths.coordinatorLog) html += kvRow("Coordinator log", paths.coordinatorLog);
    if (paths.board) html += kvRow("Board file", paths.board);
    html += "</div>";
    if (op.capacity) {
      html +=
        '<p class="guide-hint">Host capacity ceilings from host-capacity.json (shared across megas).</p>';
      html += '<div class="kv-grid">';
      var cap = op.capacity;
      ["max_coordinators", "max_builders", "max_reviewers", "max_scouts", "max_dev_servers"].forEach(
        function (k) {
          if (cap[k] != null) html += kvRow(k, cap[k]);
        },
      );
      html += "</div>";
    }
    html += "</section>";

    html += '<section class="guide-block">';
    html += "<h2>Role → CLI flags</h2>";
    html +=
      '<p class="guide-hint">Applied automatically by dispatch-grok.sh from the --agent label. Workers never pass --check or --best-of-n. Model comes from bin/model-pin.env.</p>';
    html += '<ul class="role-list">';
    roles.forEach(function (r) {
      html +=
        "<li><strong>" +
        esc(r.role) +
        "</strong><span>" +
        esc(r.flags) +
        "</span></li>";
    });
    html += "</ul></section>";

    html += '<section class="guide-block">';
    html += "<h2>Tasks</h2>";
    if (!tasks.length) html += '<div class="empty">No tasks</div>';
    else {
      html += '<div class="guide-table-wrap"><table class="guide-table"><thead><tr>';
      html += "<th>Status</th><th>Title</th><th>Owner</th><th>Files</th><th>Deps</th><th>Id</th>";
      html += "</tr></thead><tbody>";
      tasks.forEach(function (t) {
        var fileList = t.files || t.ownedFiles || [];
        var files = fileList.slice(0, 6).join(", ");
        var more = fileList.length > 6 ? "…" : "";
        html +=
          "<tr><td>" +
          statusPill(t.status) +
          "</td><td>" +
          esc(t.title || "") +
          (t.blockedReason
            ? '<div class="muted">' + esc(t.blockedReason) + "</div>"
            : "") +
          (t.friendly ? '<div class="muted">' + esc(t.friendly) + "</div>" : "") +
          "</td><td>" +
          esc(t.owner || t.ownerAgentLabel || "—") +
          '</td><td class="mono">' +
          esc(files + more || "—") +
          '</td><td class="mono">' +
          esc((t.dependsOn || []).join(", ") || "—") +
          '</td><td class="mono">' +
          esc(t.id) +
          "</td></tr>";
      });
      html += "</tbody></table></div>";
    }
    html += "</section>";

    html += '<section class="guide-block">';
    html += "<h2>Dispatches (recent)</h2>";
    if (!runs.length) html += '<div class="empty">No dispatches recorded</div>';
    else {
      html += '<div class="guide-table-wrap"><table class="guide-table"><thead><tr>';
      html +=
        "<th>Status</th><th>Agent</th><th>Task</th><th>Worktree</th><th>Session</th><th>Cost</th><th>Log</th>";
      html += "</tr></thead><tbody>";
      runs.forEach(function (r) {
        var cost =
          r.totalCostUsd != null
            ? "$" + Number(r.totalCostUsd).toFixed(4)
            : r.numTurns != null
              ? r.numTurns + " turns"
              : "—";
        var wt = r.worktreePath || r.worktree || "—";
        html +=
          "<tr><td>" +
          statusPill(r.status) +
          (r.pidAlive === false ? ' <span class="pill s-failed">dead pid</span>' : "") +
          "</td><td>" +
          esc(r.agentLabel || "—") +
          "</td><td>" +
          esc(r.taskTitle || r.taskId || "") +
          '</td><td class="mono" data-copy="' +
          esc(wt) +
          '">' +
          esc(wt) +
          '</td><td class="mono">' +
          esc(r.sessionId ? String(r.sessionId).slice(0, 12) : "—") +
          "</td><td>" +
          esc(cost) +
          '</td><td class="mono" data-copy="' +
          esc(r.logFile || "") +
          '">' +
          esc(r.logFile ? pathBase(r.logFile) : "—") +
          "</td></tr>";
      });
      html += "</tbody></table></div>";
    }
    html += "</section>";

    html += '<section class="guide-block">';
    html += "<h2>Commands — copy &amp; run</h2>";
    html +=
      '<p class="guide-hint">Personalized for this repo + swarm. Click <b>Copy</b> then paste in a terminal from the main checkout.</p>';
    sections.forEach(function (sec) {
      html += '<div class="cmd-section"><h3>' + esc(sec.title) + "</h3>";
      (sec.items || []).forEach(function (item, idx) {
        var id = "cmd-" + sec.id + "-" + idx;
        html +=
          '<article class="cmd-card">' +
          '<p class="cmd-why">' +
          esc(item.why) +
          "</p>" +
          '<pre class="cmd-pre" id="' +
          id +
          '">' +
          esc(item.cmd) +
          "</pre>" +
          '<button type="button" class="btn cmd-copy" data-cmd-id="' +
          id +
          '">Copy</button>' +
          "</article>";
      });
      html += "</div>";
    });
    html += "</section>";

    el.innerHTML = html;
  }

  /* ---------- task popover ---------- */

  function showTaskPopover(taskId, cardEl) {
    var pop = $("task-pop");
    if (!pop || !lastState) return;
    openTaskPopId = taskId;
    var tasks = lastState.tasks || [];
    var t = tasks.find(function (x) {
      return x.id === taskId;
    });
    if (!t) return;
    var byId = new Map(
      tasks.map(function (x) {
        return [x.id, x];
      }),
    );
    var deps = (t.dependsOn || [])
      .map(function (d) {
        var dep = byId.get(d);
        var done = dep && dep.status === "done";
        return (
          '<span class="pill ' +
          (done ? "dep-ok" : "dep-wait") +
          '">' +
          esc(dep ? dep.title || d : d) +
          "</span>"
        );
      })
      .join("");
    var criteria = (t.acceptanceCriteria || [])
      .map(function (a) {
        return "<li>" + esc(a) + "</li>";
      })
      .join("");
    var files = (t.ownedFiles || []).slice(0, 8);
    var notes = (t.notes || []).slice(-3);

    pop.innerHTML =
      '<button type="button" class="tp-close">Close</button>' +
      '<div class="tp-title">' +
      esc(t.title) +
      "</div>" +
      '<div class="tp-row">' +
      statusPill(t.status) +
      (t.ownerAgentLabel ? '<span class="pill">' + esc(t.ownerAgentLabel) + "</span>" : "") +
      "</div>" +
      '<div class="tp-friendly">' +
      esc(friendly(t, byId, lastState.friendlyStatus)) +
      "</div>" +
      (t.blockedReason ? '<div class="tp-block">Blocked: ' + esc(t.blockedReason) + "</div>" : "") +
      (criteria
        ? '<div class="tp-sec">Acceptance criteria</div><ul class="tp-list">' + criteria + "</ul>"
        : "") +
      (deps ? '<div class="tp-sec">Depends on</div><div class="tp-row">' + deps + "</div>" : "") +
      (files.length
        ? '<div class="tp-sec">Owned files</div><div class="tp-files">' +
          files
            .map(function (f) {
              return esc(f);
            })
            .join("<br>") +
          "</div>"
        : "") +
      (notes.length
        ? '<div class="tp-sec">Notes</div>' +
          notes
            .map(function (n) {
              return (
                '<div class="tp-note"><b>' +
                esc(n.agentLabel || "agent") +
                "</b> " +
                esc(n.text || "") +
                ' <span class="tp-when">' +
                esc(relTime(n.timestamp)) +
                "</span></div>"
              );
            })
            .join("")
        : "") +
      '<div class="tp-meta">' +
      [
        t.createdAt ? "created " + relTime(t.createdAt) : "",
        t.updatedAt ? "updated " + relTime(t.updatedAt) : "",
        t.completedAt ? "completed " + relTime(t.completedAt) : "",
      ]
        .filter(Boolean)
        .join(" / ") +
      "</div>";

    document.querySelectorAll(".card[data-task]").forEach(function (c) {
      c.style.anchorName = "";
    });
    if (cardEl) cardEl.style.anchorName = "--task-current";
    try {
      pop.showPopover();
    } catch (err) {
      /* already open */
    }
  }

  /* ---------- live runs ---------- */

  function runCardHtml(r, s) {
    var pack =
      s.swarmId === "overview" && r.swarmId
        ? '<span class="pill pill-pack">' + esc(shortSwarm(r.swarmId, r.swarmTitle)) + "</span>"
        : "";
    return (
      '<div class="run-card' +
      (selectedDispatch === r.id ? " selected" : "") +
      '" data-dispatch="' +
      esc(r.id) +
      '" data-swarm="' +
      esc(r.swarmId || s.swarmId || "") +
      '">' +
      '<div class="run-head"><b class="run-agent">' +
      esc(r.agentLabel || "agent") +
      "</b>" +
      (r.pidAlive === false ? ' <span class="warn">exited?</span>' : "") +
      pack +
      '<button type="button" class="run-info" data-info="' +
      esc(r.id) +
      '" aria-label="Run details">i</button></div>' +
      '<div class="run-title">' +
      esc(r.taskTitle || r.taskId || "") +
      "</div>" +
      '<div class="run-meta"><span class="run-elapsed" data-elapsed="' +
      Number(r.elapsedMs || 0) +
      '" data-at="' +
      Date.now() +
      '">' +
      esc(fmtDur(r.elapsedMs)) +
      "</span>" +
      (r.worktree ? " / " + esc(r.worktree) : "") +
      "</div></div>"
    );
  }

  function tickRunElapsed() {
    var now = Date.now();
    document.querySelectorAll("[data-elapsed]").forEach(function (el) {
      var base = Number(el.getAttribute("data-elapsed")) || 0;
      var at = Number(el.getAttribute("data-at")) || now;
      el.textContent = fmtDur(base + (now - at));
    });
  }

  function softUpdateRuns(s) {
    var host = $("live-runs");
    if (!host) return;
    var runs = s.runningDispatches || [];
    var cards = host.querySelectorAll(".run-card[data-dispatch]");
    if (!runs.length) {
      if (cards.length) {
        host.innerHTML = '<div class="empty">No live dispatches</div>';
      }
      var meta0 = $("now-meta");
      if (meta0) meta0.textContent = "idle";
      return;
    }
    /* If set of run ids differs, fall back to full render once. */
    var want = runs
      .map(function (r) {
        return r.id;
      })
      .sort()
      .join(",");
    var have = Array.prototype.map
      .call(cards, function (c) {
        return c.getAttribute("data-dispatch");
      })
      .sort()
      .join(",");
    if (want !== have || !cards.length) {
      renderRuns(s);
      return;
    }
    var byId = {};
    runs.forEach(function (r) {
      byId[r.id] = r;
    });
    var now = Date.now();
    Array.prototype.forEach.call(cards, function (card) {
      var id = card.getAttribute("data-dispatch");
      var r = byId[id];
      if (!r) return;
      var title = card.querySelector(".run-title");
      if (title) title.textContent = r.taskTitle || r.taskId || "";
      var agent = card.querySelector(".run-agent");
      if (agent) agent.textContent = r.agentLabel || "agent";
      /* Do NOT re-anchor data-elapsed/data-at on every soft poll — that resets
         the live timer visually. Only re-sync if server and local drift > 2.5s
         (reconnect catch-up or process restart). tickRunElapsed advances display. */
      var el = card.querySelector("[data-elapsed]");
      if (el) {
        var base = Number(el.getAttribute("data-elapsed")) || 0;
        var at = Number(el.getAttribute("data-at")) || now;
        var localElapsed = base + (now - at);
        var serverElapsed = Number(r.elapsedMs || 0);
        if (Math.abs(serverElapsed - localElapsed) > 2500) {
          el.setAttribute("data-elapsed", String(serverElapsed));
          el.setAttribute("data-at", String(now));
          el.textContent = fmtDur(serverElapsed);
        }
      }
      card.classList.toggle("selected", selectedDispatch === r.id);
    });
    var meta = $("now-meta");
    if (meta) {
      var blocked = (s.tasks || []).filter(function (t) {
        return t.status === "blocked";
      }).length;
      meta.textContent =
        (runs.length ? runs.length + " live" : "idle") + (blocked ? " / " + blocked + " blocked" : "");
    }
    if (!runTicker) runTicker = setInterval(tickRunElapsed, 1000);
  }

  function renderRuns(s) {

    var host = $("live-runs");
    var runs = s.runningDispatches || [];
    if (host) {
      host.innerHTML = runs.length
        ? runs
            .map(function (r) {
              return runCardHtml(r, s);
            })
            .join("")
        : '<div class="empty">No live dispatches</div>';
    }
    var meta = $("now-meta");
    if (meta) {
      var blocked = (s.tasks || []).filter(function (t) {
        return t.status === "blocked";
      }).length;
      meta.textContent =
        (runs.length ? runs.length + " live" : "idle") + (blocked ? " / " + blocked + " blocked" : "");
    }
    if (!runTicker) runTicker = setInterval(tickRunElapsed, 1000);
  }

  function showRunPopover(dispatchId) {
    var pop = $("run-pop");
    if (!pop || !lastState) return;
    openRunPopId = dispatchId;
    var r = (lastState.runningDispatches || []).find(function (x) {
      return x.id === dispatchId;
    });
    if (!r) return;
    /* fx.css anchors #run-pop to --run-current; without this the anchored
       branch resolves to no anchor and the panel lands in the corner. */
    document.querySelectorAll(".run-card[data-dispatch]").forEach(function (c) {
      c.style.anchorName = "";
    });
    var anchorEl = document.querySelector(
      '.run-card[data-dispatch="' + cssEscape(dispatchId) + '"]',
    );
    if (anchorEl) anchorEl.style.anchorName = "--run-current";
    var rows = [
      ["dispatch", r.id],
      ["pid", r.pid],
      ["session", r.sessionId],
      ["base", r.base],
      ["worktree", r.worktreePath || r.worktree],
      ["log", r.logFile],
    ].filter(function (row) {
      return row[1];
    });
    pop.innerHTML =
      '<button type="button" class="tp-close">Close</button>' +
      '<div class="tp-title">' +
      esc(r.agentLabel || "agent") +
      "</div>" +
      '<div class="tp-friendly">' +
      esc(r.taskTitle || r.taskId || "") +
      "</div>" +
      '<dl class="tp-kv">' +
      rows
        .map(function (row) {
          return "<dt>" + esc(row[0]) + "</dt><dd>" + esc(row[1]) + "</dd>";
        })
        .join("") +
      "</dl>";
    try {
      pop.showPopover();
    } catch (err) {
      /* already open */
    }
  }

  /* ---------- team, history, activity, landed ---------- */

  var ROLE_ORDER = ["coordinator", "builder", "reviewer", "scout", "logger"];

  function renderAgents(s) {
    var host = $("agents");
    if (!host) return;
    var agents = s.agentWorkload || [];
    if (!agents.length) {
      host.innerHTML = '<div class="empty">No agents</div>';
      return;
    }
    var groups = {};
    agents.forEach(function (a) {
      var role = a.role || "other";
      if (!groups[role]) groups[role] = [];
      groups[role].push(a);
    });
    var roles = Object.keys(groups).sort(function (a, b) {
      var ia = ROLE_ORDER.indexOf(a);
      var ib = ROLE_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    host.innerHTML = roles
      .map(function (role) {
        return (
          '<div class="agent-group"><div class="agent-role">' +
          esc(role) +
          "</div>" +
          groups[role]
            .map(function (a) {
              var n = Number(a.active || 0);
              return (
                '<div class="agent-row' +
                (n > 0 ? " is-active" : "") +
                '"><span class="agent-label">' +
                esc(a.label) +
                '</span><span class="agent-nums">' +
                n +
                " active / " +
                (a.done || 0) +
                " done</span></div>"
              );
            })
            .join("") +
          "</div>"
        );
      })
      .join("");
  }

  function renderHistory(s) {
    var host = $("dispatch-hist");
    if (!host) return;
    var hist = s.dispatchHistory || [];
    host.innerHTML = hist.length
      ? hist
          .map(function (r) {
            var code =
              r.status === "failed" && r.exitCode != null ? " (exit " + esc(r.exitCode) + ")" : "";
            var mod =
              r.status === "failed" || r.status === "killed"
                ? " is-failed"
                : r.status === "done"
                  ? " is-done"
                  : "";
            return (
              '<div class="hist' +
              mod +
              '"><b>' +
              esc(r.agentLabel || "agent") +
              '</b><span class="hist-title">' +
              esc(r.taskTitle || r.taskId || "") +
              "</span>" +
              statusPill(r.status) +
              (code ? '<span class="hist-dur">' + esc(code.trim()) + "</span>" : "") +
              '<span class="hist-dur">' +
              esc(fmtDur(r.elapsedMs)) +
              "</span></div>"
            );
          })
          .join("")
      : '<div class="empty">No history yet</div>';
  }

  function renderActivity(s) {
    var panel = $("activity-panel");
    var host = $("activity-list");
    if (!panel || !host) return;
    var feed = (s.activityFeed || []).slice(0, 8);
    if (!feed.length) {
      panel.hidden = true;
      host.innerHTML = "";
      return;
    }
    panel.hidden = false;
    var newest = 0;
    host.innerHTML = feed
      .map(function (ev) {
        var ts = Number(ev.timestamp || 0);
        if (ts > newest) newest = ts;
        var isNew = ts > lastActivityTs;
        var kind =
          ev.type === "note"
            ? "act-note"
            : ev.type === "task_created"
              ? "act-task_created"
              : ev.status === "done"
                ? "act-done"
                : ev.status === "blocked"
                  ? "act-blocked"
                  : "act-status";
        return (
          '<div class="act-item ' +
          kind +
          (isNew ? " is-new" : "") +
          '" data-goto="' +
          esc(ev.taskId || "") +
          '"><b>' +
          esc(ev.agentLabel || "agent") +
          '</b><span class="act-text">' +
          esc(ev.text || "") +
          '</span><span class="act-time">' +
          esc(relTime(ts)) +
          "</span></div>"
        );
      })
      .join("");
    if (newest) lastActivityTs = Math.max(lastActivityTs, newest);
  }

  function renderLanded(s) {
    var panel = $("landed-panel");
    var host = $("landed-list");
    if (!panel || !host) return;
    var done = (s.recentDone || []).slice(0, 5);
    if (!done.length) {
      panel.hidden = true;
      host.innerHTML = "";
      return;
    }
    panel.hidden = false;
    host.innerHTML = done
      .map(function (t) {
        return (
          '<div class="landed-row" data-goto="' +
          esc(t.id || "") +
          '"><span class="landed-title">' +
          esc(t.title || t.id || "") +
          '</span><span class="landed-time">' +
          esc(relTime(t.completedAt || t.updatedAt)) +
          "</span></div>"
        );
      })
      .join("");
  }

  /* ---------- packs ---------- */

  function namedPeersMode(reg) {
    var r = reg || store.registry || {};
    return typeof MissionRoot !== "undefined" && MissionRoot.hasNamedPeers
      ? MissionRoot.hasNamedPeers(r.swarms)
      : false;
  }

  function tabLabel(sw, reg) {
    if (typeof MissionRoot !== "undefined" && MissionRoot.tabLabel) {
      return MissionRoot.tabLabel(sw, reg || store.registry || {}, {
        isNarrow: isNarrow(),
        namedPeers: namedPeersMode(reg),
      });
    }
    var label = sw.title || sw.id;
    if (sw.id === "default" || sw.id === "overview" || sw.id === "__all__") {
      return isNarrow() ? "Main" : "Main, all packs";
    }
    if (label.length > 28) {
      var shortId = String(sw.id || "");
      if (shortId && shortId.length <= 28) return shortId;
      label = label.slice(0, 26) + "...";
    }
    return label;
  }

  function visibleSwarms(reg) {
    var swarms = (reg && reg.swarms) || [];
    var showAll = false;
    try {
      showAll =
        new URLSearchParams(window.location.search || "").get("showAll") === "1" ||
        store.prefs.get("showAllPacks", "") === "1";
    } catch (e) {
      showAll = false;
    }
    var activeId = store.selectedSwarm || (reg && reg.default) || "";
    if (typeof MissionRoot !== "undefined" && MissionRoot.isVisiblePack) {
      return swarms.filter(function (sw) {
        return MissionRoot.isVisiblePack(sw, { showAll: showAll, activeId: activeId });
      });
    }
    return swarms;
  }

  function renderSwarmTabs() {
    var tabs = $("swarm-tabs");
    if (!tabs) return;
    var reg = store.registry || { swarms: [] };
    var swarms = visibleSwarms(reg);
    // Always offer an explicit overview entry when multiple packs exist.
    var multi = ((reg.swarms || []).length > 1);
    if (!multi && swarms.length <= 1) {
      tabs.hidden = true;
      tabs.innerHTML = "";
      return;
    }
    tabs.hidden = false;
    var namedPeers = namedPeersMode(reg);
    var html = "";
    if (multi) {
      var overviewActive =
        !store.selectedSwarm ||
        (store.selectedSwarm === "default" && !namedPeers) ||
        store.selectedSwarm === "overview" ||
        store.selectedSwarm === "__all__";
      html +=
        '<button type="button" class="tab' +
        (overviewActive ? " active" : "") +
        '" data-swarm="overview">' +
        esc(isNarrow() ? (namedPeers ? "All" : "Main") : namedPeers ? "All swarms" : "Main, all packs") +
        "</button>";
    }
    html += swarms
      .filter(function (sw) {
        // Mega mode: overview button covers the historical default pack.
        // Named concurrent swarms: default is a real mission and gets its own tab.
        return sw.id !== "default" || namedPeers;
      })
      .map(function (sw) {
        return (
          '<button type="button" class="tab' +
          (sw.id === store.selectedSwarm ? " active" : "") +
          '" data-swarm="' +
          esc(sw.id) +
          '">' +
          esc(tabLabel(sw, reg)) +
          "</button>"
        );
      })
      .join("");
    tabs.innerHTML = html;
  }

  function packStateClass(sw) {
    var st = sw.stats || {};
    var c = st.counts || {};
    var building = c.building || sw.building || 0;
    var review = c.review || sw.review || 0;
    var live = sw.live || st.runningDispatches || 0;
    var done = st.done || 0;
    var total = st.total || 0;
    if (c.blocked) return "is-blocked";
    if (building || live) return "is-building";
    if (review) return "is-review";
    if (total > 0 && done >= total) return "is-done";
    return "";
  }

  function renderConstellation(s) {
    var panel = $("constellation");
    var orbit = $("constel-orbit");
    var grid = $("constel-grid");
    if (!panel || !orbit || !grid) return;
    var ov = s._overview;
    var packs = ((ov && ov.swarms) || []).filter(function (sw) {
      if (sw.isDefault && sw.id === "default" && !namedPeersMode(null)) return false;
      if (typeof MissionRoot !== "undefined" && MissionRoot.isVisiblePack) {
        return MissionRoot.isVisiblePack(sw, {
          showAll: false,
          activeId: store.selectedSwarm,
        });
      }
      return !sw.isDefault;
    });
    if (!packs.length) {
      panel.hidden = true;
      orbit.innerHTML = "";
      grid.innerHTML = "";
      return;
    }
    panel.hidden = false;
    var livePacks = packs.filter(function (sw) {
      return (sw.live || 0) > 0 || (sw.building || 0) > 0;
    }).length;
    var donePacks = packs.filter(function (sw) {
      var st = sw.stats || {};
      return st.total > 0 && st.done >= st.total;
    }).length;
    var hint = $("constel-hint");
    if (hint) {
      hint.textContent =
        packs.length +
        " packs / " +
        donePacks +
        " done" +
        (livePacks ? " / " + livePacks + " live" : "");
    }
    var n = packs.length;
    /* The orbit core is drawn by .constel-orbit::after, not by a child node. */
    orbit.innerHTML = packs
        .map(function (sw, i) {
          var ang = (i / n) * Math.PI * 2 - Math.PI / 2;
          var ring = i % 2 === 0 ? 38 : 58;
          var x = 50 + Math.cos(ang) * ring;
          var y = 50 + Math.sin(ang) * ring;
          return (
            '<span class="orbit-node ' +
            packStateClass(sw) +
            '" style="--x:' +
            x.toFixed(2) +
            "%;--y:" +
            y.toFixed(2) +
            '%" title="' +
            esc(sw.title || sw.id) +
            '" data-swarm="' +
            esc(sw.id) +
            '"></span>'
          );
        })
        .join("");
    grid.innerHTML = packs
      .map(function (sw) {
        var st = sw.stats || {};
        var c = st.counts || {};
        var building = c.building || sw.building || 0;
        var review = c.review || sw.review || 0;
        var live = sw.live || st.runningDispatches || 0;
        var done = st.done || 0;
        var total = st.total || 0;
        var pct = total ? Math.round((done / total) * 100) : 0;
        var meta = [];
        if (live) meta.push(live + " live");
        if (building) meta.push(building + " build");
        if (review) meta.push(review + " review");
        if (!meta.length) meta.push(total > 0 && done >= total ? "done" : "idle");
        return (
          '<button type="button" class="pack-node ' +
          packStateClass(sw) +
          '" data-swarm="' +
          esc(sw.id) +
          '"><div class="pn-title">' +
          esc(shortSwarm(sw.id, sw.title) || sw.title || sw.id) +
          '</div><div class="pn-ring"><div class="pn-fill" style="width:' +
          pct +
          '%"></div></div><div class="pn-meta">' +
          esc(meta.join(" / ")) +
          "</div></button>"
        );
      })
      .join("");
  }

  function goToSwarm(id) {
    var go = function () {
      store.selectSwarm(id);
      renderSwarmTabs();
    };
    if (document.startViewTransition && !document.hidden) document.startViewTransition(go);
    else go();
  }

  /* ---------- views ---------- */

  function setView(mode) {
    if (mode === "timeline" || mode === "guide") viewMode = mode;
    else viewMode = "kanban";
    store.prefs.set("view", viewMode);
    var vk = $("view-kanban");
    var vt = $("view-timeline");
    var vg = $("view-guide");
    if (vk) {
      vk.classList.toggle("active", viewMode === "kanban");
      vk.setAttribute("aria-selected", viewMode === "kanban" ? "true" : "false");
    }
    if (vt) {
      vt.classList.toggle("active", viewMode === "timeline");
      vt.setAttribute("aria-selected", viewMode === "timeline" ? "true" : "false");
    }
    if (vg) {
      vg.classList.toggle("active", viewMode === "guide");
      vg.setAttribute("aria-selected", viewMode === "guide" ? "true" : "false");
    }
    if ($("kanban-view")) $("kanban-view").hidden = viewMode !== "kanban";
    if ($("timeline-view")) $("timeline-view").hidden = viewMode !== "timeline";
    if ($("guide-view")) $("guide-view").hidden = viewMode !== "guide";
    var deck = $("deck");
    if (deck) deck.classList.toggle("guide-mode", viewMode === "guide");
    if (lastState) renderMain(lastState);
  }

  function setMobileView(mode) {
    if (mode === "guide") {
      setView("guide");
      /* Keep last board/mission/ops/chat region for when user leaves guide. */
    } else {
      if (viewMode === "guide") setView("kanban");
      mobileView = MOBILE_VIEWS.indexOf(mode) >= 0 ? mode : "board";
      store.prefs.set("mview", mobileView);
    }
    var deck = $("deck");
    if (deck) {
      deck.classList.remove("mob-board", "mob-mission", "mob-ops", "mob-chat", "mob-guide");
      if (viewMode === "guide") deck.classList.add("mob-guide");
      else deck.classList.add("mob-" + mobileView);
    }
    var onBoard = isNarrow() && mobileView === "board" && viewMode !== "guide";
    document.body.classList.toggle("mob-board-view", onBoard);
    var onChat = onChatTab();
    document.body.classList.toggle("mob-chat-view", onChat);
    ["board", "mission", "ops", "chat", "guide"].forEach(function (m) {
      var btn = $("mob-" + m);
      if (!btn) return;
      var on = m === "guide" ? viewMode === "guide" : m === mobileView && viewMode !== "guide";
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-current", on ? "page" : "false");
    });
    if (lastState) {
      renderMobChrome(lastState);
      if (onBoard) renderMobChips(lastState);
    }
    var chatInput = $("chat-input");
    if (chatInput) {
      chatInput.placeholder = isNarrow()
        ? "Message the coordinator"
        : "Steer the coordinator… (Enter to send, Shift+Enter newline)";
    }
    if (onChat) {
      markChatSeen();
      fitComposer();
      var list = $("chat-list");
      if (list) list.scrollTop = list.scrollHeight;
    } else {
      setTaskSheet(false);
    }
    /* Snap scroll to top of active region when switching tabs (mobile). */
    var app = $("app");
    if (app && isNarrow()) app.scrollTop = 0;
  }

  function updateMobBadge(id, n, kind) {
    var el = $(id);
    if (!el) return;
    if (!n) {
      el.hidden = true;
      el.textContent = "";
      el.classList.remove("is-alert", "is-warn");
      return;
    }
    el.hidden = false;
    el.textContent = n > 99 ? "99+" : String(n);
    el.classList.toggle("is-alert", kind === "alert");
    el.classList.toggle("is-warn", kind === "warn");
  }

  function renderMobChrome(s) {
    if (!isNarrow()) {
      document.body.classList.remove("mob-board-view", "mob-has-chips", "mob-chat-view");
      var chipsOff = $("mob-chips");
      if (chipsOff) chipsOff.hidden = true;
      return;
    }
    var live = liveCount(s);
    var st = s.stats || {};
    var c = st.counts || {};
    var blocked = c.blocked || 0;
    var building = c.building || 0;
    updateMobBadge("mob-badge-ops", live, live > 0 ? "" : "");
    updateMobBadge(
      "mob-badge-mission",
      blocked || building,
      blocked ? "alert" : building ? "warn" : "",
    );
    renderMobNow(s);
    var onBoard = mobileView === "board" && viewMode !== "guide";
    document.body.classList.toggle("mob-board-view", onBoard);
    if (onBoard) renderMobChips(s);
    else {
      document.body.classList.remove("mob-has-chips");
      var chips = $("mob-chips");
      if (chips) chips.hidden = true;
    }
  }

  /* Glanceable mission line at the top of the phone board. */
  function renderMobNow(s) {
    var host = $("mob-now");
    if (!host) return;
    var st = s.stats || {};
    var c = st.counts || {};
    var pct = Number(st.pct || 0);
    $("mob-now-pct").textContent = pct + "%";
    $("mob-now-count").textContent = st.total ? (st.done || 0) + " of " + st.total + " done" : "No tracked tasks";
    var bits = [];
    var live = liveCount(s);
    if (live) bits.push(live + " live");
    if (c.building) bits.push(c.building + " building");
    if (c.blocked) bits.push(c.blocked + " blocked");
    if (c.review) bits.push(c.review + " in review");
    if (etaTargetTs > Date.now()) bits.push("eta ~" + fmtDur(etaTargetTs - Date.now()));
    $("mob-now-sub").textContent = bits.join(" · ") || (s.goal && s.goal.title) || "";
    host.setAttribute("aria-label", "Mission " + pct + "% done. Open mission details");
    var ram = $("mob-now-ram");
    var hm = s.hostMemory;
    if (ram && hm && hm.availableGb != null) {
      var thr = hm.minFreeGb != null ? hm.minFreeGb : 2;
      var low = !!hm.low || hm.availableGb < thr;
      var warn = !low && hm.availableGb < thr * 1.5;
      ram.hidden = !(low || warn);
      ram.textContent = "RAM " + hm.availableGb + "G";
      ram.classList.toggle("is-crit", low);
    } else if (ram) {
      ram.hidden = true;
    }
  }

  function boardCounts(s) {
    var tasks = boardTasks(s);
    var counts = { Queued: 0, Building: 0, Review: 0, Blocked: 0, Done: 0 };
    var buckets =
      boardCol && typeof boardCol.bucketTasks === "function"
        ? boardCol.bucketTasks(tasks, s.runningDispatches || [])
        : null;
    if (buckets) {
      Object.keys(counts).forEach(function (name) {
        counts[name] = (buckets[name] || []).length;
      });
    } else {
      tasks.forEach(function (t) {
        var col = boardColumnForStatus(t.status);
        if (col && counts[col] !== undefined) counts[col] += 1;
      });
    }
    var runs = s.runningDispatches || [];
    var hasLive = runs.some(function (r) {
      return boardCol && !!boardCol.liveColumnForRole(boardCol.roleFromAgentLabel(r.agentLabel));
    });
    var live =
      hasLive && buckets && boardCol && typeof boardCol.preferredBoardColumn === "function"
        ? boardCol.preferredBoardColumn(buckets, runs)
        : "";
    return { counts: counts, live: live };
  }

  /* Status tabs: one column at a time. The operator's pick wins while it has
     cards, then the column with live work, then SwarmMobileModel.defaultColumn. */
  function renderMobChips(s) {
    var host = $("mob-chips");
    if (!host || !isNarrow()) return;
    var bc = boardCounts(s);
    var counts = bc.counts;
    var order = ["Queued", "Building", "Review", "Blocked", "Done"];
    var nonEmpty = order.filter(function (name) {
      return counts[name] > 0;
    });
    if (!nonEmpty.length) {
      host.hidden = true;
      document.body.classList.remove("mob-has-chips");
      host.innerHTML = "";
      setBoardCol("");
      return;
    }
    host.hidden = false;
    document.body.classList.add("mob-has-chips");
    var activeCol = mobModel
      ? mobModel.pickColumn(counts, userBoardCol, bc.live)
      : bc.live || nonEmpty[0];
    host.innerHTML = nonEmpty
      .map(function (name) {
        var on = name === activeCol;
        return (
          '<button type="button" role="tab" class="chip' +
          (on ? " active" : "") +
          '" aria-selected="' +
          (on ? "true" : "false") +
          '" data-col="' +
          esc(name) +
          '">' +
          esc(name) +
          '<span class="n">' +
          counts[name] +
          "</span></button>"
        );
      })
      .join("");
    setBoardCol(activeCol);
  }

  function setBoardCol(name) {
    var host = $("kanban-view");
    if (host) {
      if (name) host.setAttribute("data-active", name);
      else host.removeAttribute("data-active");
    }
    var chips = $("mob-chips");
    if (!chips) return;
    chips.setAttribute("data-active", name || "");
    Array.prototype.forEach.call(chips.querySelectorAll(".chip"), function (btn) {
      var on = btn.getAttribute("data-col") === name;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
  }

  /* ---------- log sheet ---------- */

  function openLog(dispatchId, swarmId) {
    selectedDispatch = dispatchId;
    selectedDispatchSwarm = swarmId || (lastState && lastState.swarmId) || "";
    var sheet = $("log-drawer");
    if (!sheet) return;
    sheet.classList.add("open");
    sheet.setAttribute("aria-hidden", "false");
    stickLogBottom = true;
    refreshLog();
    if (logTimer) clearInterval(logTimer);
    logTimer = setInterval(refreshLog, 3000);
  }

  function closeLog() {
    var sheet = $("log-drawer");
    if (sheet) {
      sheet.classList.remove("open");
      sheet.setAttribute("aria-hidden", "true");
    }
    if (logTimer) {
      clearInterval(logTimer);
      logTimer = null;
    }
  }

  function isLogOpen() {
    var sheet = $("log-drawer");
    return !!(sheet && sheet.classList.contains("open"));
  }

  function refreshLog() {
    if (!selectedDispatch || !isLogOpen()) return;
    var body = $("log-body");
    if (!body) return;
    store
      .fetchLog(selectedDispatch, selectedDispatchSwarm)
      .then(function (data) {
        if (!isLogOpen()) return;
        if ($("log-title")) $("log-title").textContent = data.title;
        if ($("log-meta")) {
          $("log-meta").textContent = selectedDispatch + " / " + data.lines.length + " lines";
        }
        var atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
        body.innerHTML = data.lines.length
          ? data.lines
              .map(function (l) {
                return (
                  '<div class="log-line ' +
                  l.cls +
                  (l.fresh ? " line-in" : "") +
                  '">' +
                  esc(l.text) +
                  "</div>"
                );
              })
              .join("")
          : '<div class="empty">No log lines yet</div>';
        if (stickLogBottom || atBottom) body.scrollTop = body.scrollHeight;
      })
      .catch(function () {
        body.innerHTML = '<div class="empty">Could not load log</div>';
      });
  }

  function copyLog() {
    if (!selectedDispatch) return;
    store
      .fetchLog(selectedDispatch, selectedDispatchSwarm)
      .then(function (data) {
        copyText(
          data.lines
            .map(function (l) {
              return l.text;
            })
            .join("\n"),
        );
      })
      .catch(function () {
        /* nothing to copy */
      });
  }

  /* ---------- footer + connection ---------- */

  var footerAgeTimer = null;

  function renderFooter(s) {
    var footer = $("footer");
    if (!footer || offline) return;
    var ts = Number(s.updatedAt || store.lastUpdatedAt || Date.now());
    var ageMs = Date.now() - ts;
    var age =
      ageMs < 5000 ? "just now" : ageMs < 60000 ? Math.floor(ageMs / 1000) + "s ago" : relTime(ts);
    var mem =
      s.hostMemory && s.hostMemory.availableGb != null
        ? " · RAM " + s.hostMemory.availableGb + "G"
        : "";
    var live = liveCount(s);
    footer.textContent =
      (live ? "● " + live + " live · " : "") +
      "Synced " +
      age +
      " · poll " +
      Math.round(store.pollMs / 1000) +
      "s" +
      mem;
    footer.classList.toggle("is-stale", ageMs > 12000);
    footer.classList.toggle("is-live", ageMs <= 12000);
    if (!footerAgeTimer) {
      footerAgeTimer = setInterval(function () {
        if (lastState && !offline) renderFooter(lastState);
        renderCommand();
      }, 1000);
    }
  }

  function onConnLost() {
    offline = true;
    var dot = $("dot");
    if (dot) {
      dot.classList.add("stale");
      dot.classList.remove("live");
    }
    if ($("dot-label")) $("dot-label").textContent = "Offline";
    var banner = $("health-banner");
    if (banner) {
      banner.hidden = false;
      banner.className = "banner bad";
      banner.textContent =
        "Cannot reach /api/state. Reopen this page or restart: swarm dashboard --daemon --port 4599";
    }
    if ($("footer")) $("footer").textContent = "Connection lost. Is the dashboard process running?";
    renderCommand();
  }

  function onConnOk() {
    offline = false;
    var dot = $("dot");
    if (dot) dot.classList.remove("stale");
    var banner = $("health-banner");
    if (banner) {
      banner.hidden = true;
      banner.textContent = "";
    }
  }

  /* ---------- telemetry ---------- */

  function pushTelemetry(s) {
    var st = s.stats || {};
    var c = st.counts || {};
    var live = liveCount(s);
    engineCall("setTelemetry", {
      live: live,
      building: c.building || 0,
      review: c.review || 0,
      blocked: c.blocked || 0,
      ramPct: s.hostMemory && s.hostMemory.pctUsed != null ? s.hostMemory.pctUsed : 30,
      progressPct: st.pct || 0,
    });
    var statuses = {};
    (s.tasks || []).forEach(function (t) {
      statuses[t.id] = t.status;
    });
    engineCall("setClusters", s.runningDispatches || [], statuses);
    audio.setLive(live);
  }

  /* ---------- render ---------- */

  var pendingTransitions = 0;

  function isPopoverOpen(id) {
    var pop = $(id);
    if (!pop) return false;
    try {
      if (typeof pop.matches === "function" && pop.matches(":popover-open")) return true;
    } catch (err) {
      /* :popover-open unsupported */
    }
    return pop.hasAttribute("open") || pop.classList.contains("open");
  }

  function render(s) {
    lastState = s;
    var scrollSnap = captureScroll();
    var keepTaskPop = openTaskPopId && isPopoverOpen("task-pop");
    var keepRunPop = openRunPopId && isPopoverOpen("run-pop");
    var taskPopId = keepTaskPop ? openTaskPopId : null;
    var runPopId = keepRunPop ? openRunPopId : null;

    renderHeader(s);
    renderPause(s);
    renderHealth(s);
    renderMemory(s);
    renderStats(s);
    renderMission(s);
    /* View transitions only on real task status flips — never on every hard poll.
       Root/board crossfade on routine structure refresh is what felt like "blink". */
    if (pendingTransitions > 0 && document.startViewTransition && !document.hidden) {
      document.startViewTransition(function () {
        renderMain(s);
      });
    } else {
      renderMain(s);
    }
    pendingTransitions = 0;
    renderRuns(s);
    renderAgents(s);
    renderHistory(s);
    renderActivity(s);
    renderLanded(s);
    renderConstellation(s);
    renderSwarmTabs();
    if (!selectedDispatch && (s.runningDispatches || []).length) {
      selectedDispatch = s.runningDispatches[0].id;
      selectedDispatchSwarm = s.runningDispatches[0].swarmId || s.swarmId || "";
    }
    pushTelemetry(s);
    renderFooter(s);
    renderMobChrome(s);

    /* Restore interaction chrome the full rebuild would otherwise drop.
       The phone board column comes from renderMobChips (pickColumn). */
    restoreScroll(scrollSnap);
    if (taskPopId) {
      var card = document.querySelector('.card[data-task="' + cssEscape(taskPopId) + '"]');
      if (card) showTaskPopover(taskPopId, card);
      else openTaskPopId = null;
    }
    if (runPopId) {
      var still = (s.runningDispatches || []).some(function (r) {
        return r.id === runPopId;
      });
      if (still) showRunPopover(runPopId);
      else openRunPopId = null;
    }
  }

  function onTransition(ch) {
    pendingTransitions += 1;
    if (ch.to === "done") {
      engineCall("pulse", "done", ch.id);
      flashMarks[ch.id] = { cls: "just-done", until: Date.now() + 5000 };
      audio.chime();
    } else if (ch.to === "blocked") {
      engineCall("pulse", "blocked", ch.id);
      flashMarks[ch.id] = { cls: "just-blocked", until: Date.now() + 5000 };
    }
  }

  /* ---------- wiring ---------- */

  function wire() {
    if ($("view-kanban")) $("view-kanban").onclick = function () {
      setView("kanban");
    };
    if ($("view-timeline")) $("view-timeline").onclick = function () {
      setView("timeline");
    };
    if ($("view-guide")) $("view-guide").onclick = function () {
      setView("guide");
    };
    var mainGuide = $("guide-view");
    if (mainGuide) {
      mainGuide.addEventListener("click", function (e) {
        var btn = e.target.closest ? e.target.closest(".cmd-copy[data-cmd-id]") : null;
        if (btn) {
          var pre = $(btn.getAttribute("data-cmd-id"));
          if (pre) {
            copyText(pre.textContent || "");
            btn.textContent = "Copied";
            btn.classList.add("copied");
            setTimeout(function () {
              btn.textContent = "Copy";
              btn.classList.remove("copied");
            }, 1200);
          }
          return;
        }
        var code = e.target.closest ? e.target.closest("[data-copy]") : null;
        if (code && code.getAttribute("data-copy")) {
          copyText(code.getAttribute("data-copy"));
        }
      });
    }
    setView(viewMode);

    ["hold", "pause", "resume"].forEach(function (a) {
      var b = $("ctl-" + a);
      if (b) b.onclick = function () { controlAction(a, b); };
    });
    var cap = $("mob-state");
    if (cap) cap.onclick = function () { showToast(pauseSummary(), ""); };
    if ($("toast-x")) $("toast-x").onclick = function () { showToast(""); };

    var chatForm = $("chat-form"), chatInput = $("chat-input");
    if (chatForm && chatInput) {
      chatForm.onsubmit = function (e) {
        e.preventDefault();
        var text = chatInput.value.trim();
        if (!text) return;
        chatInput.disabled = true;
        sendChat(text).then(function (ok) {
          chatInput.disabled = false;
          if (ok) chatInput.value = "";
          fitComposer();
        });
      };
      chatInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); chatForm.requestSubmit(); }
      });
      chatInput.addEventListener("input", fitComposer);
    }
    var quick = $("chat-quick");
    if (quick) {
      quick.addEventListener("click", function (e) {
        var chip = e.target.closest ? e.target.closest(".chat-chip[data-say]") : null;
        if (!chip || chip.disabled) return;
        chip.disabled = true;
        sendChat(chip.getAttribute("data-say")).then(function (ok) {
          chip.disabled = false;
          if (ok) showToast("Sent: " + chip.textContent.trim(), "ok");
        });
      });
    }
    var taskForm = $("task-form");
    if (taskForm) {
      taskForm.onsubmit = function (e) {
        e.preventDefault();
        var title = $("task-title").value;
        apiPost("/api/task", {
          title: title, files: $("task-files").value, acceptance: $("task-acceptance").value,
        }).then(function (r) {
          if (!r.ok) {
            showChatError("task create failed: " + (r.stderr || r.stdout || r.error || "").slice(0, 600));
            showToast("Task not created: " + (apiError(r) || "no output"), "bad");
            return;
          }
          showChatError("");
          taskForm.reset();
          setTaskSheet(false);
          showToast("Task created: " + title, "ok");
          if (window.SwarmStore && window.SwarmStore.refresh) window.SwarmStore.refresh();
        }).catch(function (err) {
          showToast("Task not created: " + String(err), "bad");
        });
      };
    }
    if ($("chat-add")) $("chat-add").onclick = function () {
      var sheet = $("task-sheet");
      setTaskSheet(!(sheet && sheet.open));
    };
    if ($("task-sheet-close")) $("task-sheet-close").onclick = function () { setTaskSheet(false); };
    if ($("sheet-scrim")) $("sheet-scrim").onclick = function () { setTaskSheet(false); };
    if (window.SwarmStore && window.SwarmStore.on) window.SwarmStore.on("tick", loadChat);
    loadChat();

    var nav = $("mob-nav");
    if (nav) {
      nav.addEventListener("click", function (e) {
        var btn = e.target.closest ? e.target.closest("button[data-mview]") : null;
        if (!btn) return;
        e.preventDefault();
        setMobileView(btn.getAttribute("data-mview") || "board");
        /* Wake the store so the tab always shows fresh data after a switch. */
        if (typeof store.refresh === "function") store.refresh();
      });
    }
    var chips = $("mob-chips");
    if (chips) {
      chips.addEventListener("click", function (e) {
        var btn = e.target.closest ? e.target.closest(".chip[data-col]") : null;
        if (!btn) return;
        e.preventDefault();
        userBoardCol = btn.getAttribute("data-col") || "";
        store.prefs.set("mcol", userBoardCol);
        setBoardCol(userBoardCol);
        var app = $("app");
        if (app) app.scrollTop = 0;
      });
    }
    if ($("mob-now")) $("mob-now").onclick = function () { setMobileView("mission"); };

    /* iOS keeps the layout viewport when the keyboard opens; track the visual
       viewport so the composer and task sheet stay above the keyboard. */
    var vv = window.visualViewport;
    if (vv) {
      var syncVV = function () {
        var kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        var open = isNarrow() && kb > 120;
        var rs = document.documentElement.style;
        document.body.classList.toggle("kb-open", open);
        rs.setProperty("--m-vvh", vv.height + "px");
        rs.setProperty("--m-vvtop", vv.offsetTop + "px");
      };
      vv.addEventListener("resize", syncVV);
      vv.addEventListener("scroll", syncVV);
    }
    ["task-pop", "run-pop"].forEach(function (id) {
      var pop = $(id);
      if (!pop) return;
      pop.addEventListener("click", function (e) {
        if (e.target.closest && e.target.closest(".tp-close")) {
          try { pop.hidePopover(); } catch (err) { /* already closed */ }
        }
      });
    });
    setMobileView(mobileView);
    window.addEventListener("resize", function () {
      setMobileView(viewMode === "guide" ? "guide" : mobileView);
    });

    var cine = $("cinematic-toggle");
    if (cine) {
      var on = store.prefs.get("cinematic", "0") === "1";
      document.body.classList.toggle("cinematic", on);
      cine.setAttribute("aria-pressed", on ? "true" : "false");
      cine.onclick = function () {
        var next = !document.body.classList.contains("cinematic");
        document.body.classList.toggle("cinematic", next);
        cine.setAttribute("aria-pressed", next ? "true" : "false");
        store.prefs.set("cinematic", next ? "1" : "0");
        /* AudioContext must be created inside this user gesture. */
        if (next) audio.start();
        else audio.stop();
        engineCall("refreshColors");
      };
    }

    var tabs = $("swarm-tabs");
    if (tabs) {
      tabs.addEventListener("click", function (e) {
        var btn = e.target.closest ? e.target.closest(".tab[data-swarm]") : null;
        if (!btn) return;
        goToSwarm(btn.getAttribute("data-swarm"));
      });
    }

    var constel = $("constellation");
    if (constel) {
      constel.addEventListener("click", function (e) {
        var node = e.target.closest ? e.target.closest("[data-swarm]") : null;
        if (!node) return;
        goToSwarm(node.getAttribute("data-swarm"));
      });
    }

    var main = $("main-view");
    if (main) {
      main.addEventListener("click", function (e) {
        var card = e.target.closest ? e.target.closest(".card[data-task]") : null;
        if (!card) return;
        showTaskPopover(card.getAttribute("data-task"), card);
      });
    }

    var runs = $("live-runs");
    if (runs) {
      runs.addEventListener("click", function (e) {
        var info = e.target.closest ? e.target.closest(".run-info[data-info]") : null;
        if (info) {
          e.stopPropagation();
          showRunPopover(info.getAttribute("data-info"));
          return;
        }
        var card = e.target.closest ? e.target.closest(".run-card[data-dispatch]") : null;
        if (!card) return;
        openLog(card.getAttribute("data-dispatch"), card.getAttribute("data-swarm"));
        if (lastState) renderRuns(lastState);
      });
      runs.addEventListener("contextmenu", function (e) {
        var card = e.target.closest ? e.target.closest(".run-card[data-dispatch]") : null;
        if (!card) return;
        e.preventDefault();
        showRunPopover(card.getAttribute("data-dispatch"));
      });
      var pressTimer = null;
      runs.addEventListener(
        "pointerdown",
        function (e) {
          var card = e.target.closest ? e.target.closest(".run-card[data-dispatch]") : null;
          if (!card) return;
          pressTimer = setTimeout(function () {
            showRunPopover(card.getAttribute("data-dispatch"));
          }, 550);
        },
        { passive: true },
      );
      var clearPress = function () {
        if (pressTimer) clearTimeout(pressTimer);
        pressTimer = null;
      };
      runs.addEventListener("pointerup", clearPress, { passive: true });
      runs.addEventListener("pointercancel", clearPress, { passive: true });
      runs.addEventListener("pointerleave", clearPress, { passive: true });
    }

    document.addEventListener("click", function (e) {
      var goto = e.target.closest ? e.target.closest("[data-goto]") : null;
      if (goto) {
        var id = goto.getAttribute("data-goto");
        if (id) {
          e.preventDefault();
          if (isNarrow()) setMobileView("board");
          flashTask(id);
        }
        return;
      }
      var copyBtn = e.target.closest ? e.target.closest(".resume-copy[data-copy]") : null;
      if (copyBtn) {
        var pre = $("resume-cmd-" + copyBtn.getAttribute("data-copy"));
        if (pre) {
          copyText(pre.textContent);
          copyBtn.textContent = "Copied";
          copyBtn.classList.add("copied");
          setTimeout(function () {
            copyBtn.textContent = "Copy";
            copyBtn.classList.remove("copied");
          }, 1500);
        }
      }
    });

    if ($("log-close")) $("log-close").onclick = closeLog;
    if ($("log-copy")) $("log-copy").onclick = copyLog;
    var logBody = $("log-body");
    if (logBody) {
      logBody.addEventListener(
        "scroll",
        function () {
          stickLogBottom =
            logBody.scrollHeight - logBody.scrollTop - logBody.clientHeight < 40;
        },
        { passive: true },
      );
    }

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeLog();
    });

    window.addEventListener("resize", function () {
      if (lastState) renderMain(lastState);
    });
  }

  /* ---------- boot ---------- */

  store.on("registry", function () {
    renderSwarmTabs();
  });
  store.on("transition", onTransition);
  store.on("state", render);
  store.on("tick", function (s) {
    /* Soft update only: board structure is unchanged. Avoid full innerHTML rebuilds
       that caused a visible "blink" / awkward reflow every poll. */
    lastState = s;
    renderFooter(s);
    renderMemory(s);
    renderMission(s);
    renderStats(s);
    softUpdateRuns(s);
    renderMobChrome(s);
    /* Guide is operator-facing and includes live daemon pills — refresh when open. */
    if (viewMode === "guide") renderGuide(s);
    pushTelemetry(s);
    var liveN = (s.runningDispatches || []).length;
    var dot = $("dot");
    if (dot) {
      dot.classList.toggle("live", liveN > 0);
      dot.classList.remove("stale");
    }
    if ($("dot-label")) {
      var st1 = s.stats || {};
      var phase1 = st1.phase || (liveN > 0 ? "live" : "idle");
      if (phase1 === "live") $("dot-label").textContent = "Live";
      else if (phase1 === "coord-lag") $("dot-label").textContent = "Coord lag";
      else if (phase1 === "review") $("dot-label").textContent = "Review";
      else if (phase1 === "done") $("dot-label").textContent = "Done";
      else $("dot-label").textContent = "Idle";
    }
  });
  store.on("connlost", onConnLost);
  store.on("connok", onConnOk);

  wire();
  initFieldForViewport();
  store.init();
})();
