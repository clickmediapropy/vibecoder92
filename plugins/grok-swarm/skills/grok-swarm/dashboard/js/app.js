/**
 * UNUSED LEGACY DUAL RENDERER — not loaded by templates/dashboard.html.
 *
 * Mission Control ships a single pipeline: structure-key.js → data.js → ui.js
 * (plus optional engine.js for the WebGL field). This file is kept only as a
 * historical reference; do not <script src> it. Editing the live UI means
 * editing data.js / ui.js / structure-key.js.
 *
 * Status: unused / demoted (2026-07-30 soft-vs-hard dashboard refactor).
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );

  const LS_SWARM = "grok-swarm-dash-swarm";
  const LS_VIEW = "grok-swarm-dash-view";
  const LS_MVIEW = "grok-swarm-dash-mview";
  const LS_NOW = "grok-swarm-now-collapsed";
  const LS_CINE = "grok-swarm-cinematic";

  let lastUpdatedAt = 0;
  let pollTimer = null;
  let logTimer = null;
  let selectedSwarm = localStorage.getItem(LS_SWARM) || "";
  let selectedDispatch = null;
  let stickLogBottom = true;
  let lastState = null;
  let registry = { swarms: [], default: null };
  let viewMode = localStorage.getItem(LS_VIEW) || "kanban";
  let mobileView = localStorage.getItem(LS_MVIEW) || "board";
  let failures = 0;
  let field = null;
  window.__megaBusy = false;
  window.__swarmSnaps = {};
  window.__nowExpanded = false;
  let taskStatuses = {}; // taskId → last seen status (for transition choreography)
  let flashMarks = {}; // taskId → { cls, until } for just-done / just-blocked card flashes
  let statHistory = {}; // label → last N values (real poll samples → CSS sparklines)
  let etaTargetTs = 0; // wall-clock ms when mission ETA lands (from s.eta, corrected each poll)
  let etaTicker = null;
  let logSeenCount = 0; // rendered log lines for current dispatch (new-line reveal)
  let logSeenDispatch = null;

  /* Opt-in sonification — lives strictly behind the Cinema toggle (user gesture). */
  const audio = {
    ctx: null,
    master: null,
    filter: null,
    on: false,
    start() {
      if (this.on) return;
      try {
        this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
        this.ctx.resume();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.035;
        this.filter = this.ctx.createBiquadFilter();
        this.filter.type = "lowpass";
        this.filter.frequency.value = 220;
        const mk = (freq, detune) => {
          const o = this.ctx.createOscillator();
          o.type = "triangle";
          o.frequency.value = freq;
          o.detune.value = detune;
          o.connect(this.filter);
          o.start();
          return o;
        };
        this._oscs = [mk(55, 0), mk(110, 6)];
        this.filter.connect(this.master);
        this.master.connect(this.ctx.destination);
        this.on = true;
      } catch {
        /* audio unavailable */
      }
    },
    stop() {
      if (!this.on) return;
      try {
        (this._oscs || []).forEach((o) => o.stop());
        this.master.disconnect();
      } catch {
        /* noop */
      }
      this.on = false;
    },
    setLive(n) {
      if (!this.on || !this.filter) return;
      const f = 160 + Math.min(12, n) * 110;
      this.filter.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.6);
    },
    chime() {
      if (!this.on || !this.ctx) return;
      try {
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.type = "sine";
        o.frequency.setValueAtTime(880, this.ctx.currentTime);
        o.frequency.exponentialRampToValueAtTime(1318, this.ctx.currentTime + 0.18);
        g.gain.setValueAtTime(0.06, this.ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.7);
        o.connect(g);
        g.connect(this.ctx.destination);
        o.start();
        o.stop(this.ctx.currentTime + 0.75);
      } catch {
        /* noop */
      }
    },
  };

  function fmtDur(ms) {
    const s = Math.max(0, Math.floor((ms || 0) / 1000));
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    return m + "m" + String(s % 60).padStart(2, "0") + "s";
  }

  function isNarrow() {
    return window.matchMedia("(max-width: 900px)").matches;
  }

  function friendly(t, byId, fs) {
    if (fs && fs[t.id]) return fs[t.id];
    const who = t.ownerAgentLabel || "someone";
    switch (t.status) {
      case "done":
        return "Done";
      case "building":
        return who + " is building";
      case "planning":
        return who + " is planning";
      case "review":
        // Not "paused" — builders finished; coordinator must verify/merge/mark done
        return "Builders finished — waiting on coordinator (not paused)";
      case "blocked":
        return "Blocked: " + (t.blockedReason || "needs help");
      case "assigned": {
        const w = (t.dependsOn || []).filter((d) => {
          const dep = byId.get(d);
          return !dep || dep.status !== "done";
        });
        return w.length ? "Waiting on " + w.join(", ") : "Queued for " + who;
      }
      default:
        return "Waiting to be picked up";
    }
  }

  function statusTone(status) {
    if (status === "building" || status === "planning")
      return { c: "var(--blue)", bg: "var(--blue-soft)" };
    if (status === "review") return { c: "var(--purple)", bg: "var(--purple-soft)" };
    if (status === "blocked") return { c: "var(--red)", bg: "var(--red-soft)" };
    if (status === "done") return { c: "var(--green)", bg: "var(--green-soft)" };
    if (status === "open" || status === "assigned")
      return { c: "var(--amber)", bg: "var(--amber-soft)" };
    return { c: "var(--fg-3)", bg: "transparent" };
  }

  function shortSwarm(id, title) {
    if (!id) return "";
    const m = String(id).match(/iss-([\w-]+)$/);
    if (m) return "#" + m[1].replace(/-/g, "·");
    if (title && title.length < 28) return title;
    return String(id).slice(-24);
  }

  function setView(mode) {
    viewMode = mode;
    localStorage.setItem(LS_VIEW, mode);
    const vk = $("view-kanban");
    const vt = $("view-timeline");
    if (vk) vk.classList.toggle("active", mode === "kanban");
    if (vt) vt.classList.toggle("active", mode === "timeline");
    if ($("kanban-view")) $("kanban-view").hidden = mode !== "kanban";
    if ($("timeline-view")) $("timeline-view").hidden = mode !== "timeline";
    if (lastState) renderMain(lastState);
  }

  function setMobileView(mode) {
    mobileView = mode === "timeline" ? "timeline" : mode === "runs" ? "runs" : "board";
    localStorage.setItem(LS_MVIEW, mobileView);
    const layout = $("layout");
    const main = $("main-view");
    const side = layout ? layout.querySelector(".side-panel") : null;
    if (layout) {
      layout.classList.remove("mobile-board", "mobile-timeline", "mobile-runs");
      layout.classList.add("mobile-" + mobileView);
    }
    const narrow = isNarrow();
    if (narrow) {
      if (main) main.style.display = mobileView === "runs" ? "none" : "";
      if (side) side.style.display = mobileView === "runs" ? "block" : "none";
    } else {
      if (main) main.style.display = "";
      if (side) side.style.display = "";
    }
    ["board", "timeline", "runs"].forEach((m) => {
      const btn = $("mob-" + m);
      if (btn) {
        btn.classList.toggle("active", m === mobileView);
        btn.setAttribute("aria-current", m === mobileView ? "page" : "false");
      }
    });
    if (mobileView === "board") setView("kanban");
    else if (mobileView === "timeline") setView("timeline");
  }

  function applyNowCollapsed(collapsed) {
    const panel = $("now-panel");
    const btn = $("now-toggle");
    if (!panel || !btn) return;
    panel.classList.toggle("is-collapsed", !!collapsed);
    btn.textContent = collapsed ? "Show" : "Hide";
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    localStorage.setItem(LS_NOW, collapsed ? "1" : "0");
  }

  function wireChrome() {
    if ($("view-kanban")) $("view-kanban").onclick = () => setView("kanban");
    if ($("view-timeline")) $("view-timeline").onclick = () => setView("timeline");
    setView(viewMode);

    const nav = $("mob-nav");
    if (nav) {
      nav.addEventListener(
        "click",
        (e) => {
          const btn = e.target.closest && e.target.closest("button[data-mview]");
          if (!btn) return;
          e.preventDefault();
          setMobileView(btn.getAttribute("data-mview") || "board");
        },
        { passive: false },
      );
    }
    setMobileView(mobileView);

    const nt = $("now-toggle");
    if (nt) {
      nt.addEventListener("click", (e) => {
        e.preventDefault();
        const panel = $("now-panel");
        applyNowCollapsed(!(panel && panel.classList.contains("is-collapsed")));
      });
    }
    const more = $("now-more");
    if (more) {
      more.addEventListener("click", (e) => {
        e.preventDefault();
        window.__nowExpanded = !window.__nowExpanded;
        if (lastState) renderSide(lastState);
      });
    }
    applyNowCollapsed(localStorage.getItem(LS_NOW) === "1");

    if ($("log-close")) $("log-close").onclick = closeLogDrawer;
    if ($("log-refresh")) $("log-refresh").onclick = fetchLog;
    if ($("log-copy")) {
      $("log-copy").onclick = async () => {
        const q = new URLSearchParams({
          swarm: lastState?._logSwarm || lastState?.swarmId || "",
          dispatch: selectedDispatch || "",
          format: "plain",
          lines: "40",
        });
        try {
          const res = await fetch("/api/log-tail?" + q);
          const data = await res.json();
          copyText((data.lines || []).join("\n"));
        } catch {
          /* noop */
        }
      };
    }
    if ($("log-body")) {
      $("log-body").onscroll = () => {
        const body = $("log-body");
        stickLogBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
      };
    }

    const cine = $("cinematic-toggle");
    if (cine) {
      const on = localStorage.getItem(LS_CINE) === "1";
      document.body.classList.toggle("cinematic", on);
      cine.setAttribute("aria-pressed", on ? "true" : "false");
      cine.onclick = () => {
        const next = !document.body.classList.contains("cinematic");
        document.body.classList.toggle("cinematic", next);
        cine.setAttribute("aria-pressed", next ? "true" : "false");
        localStorage.setItem(LS_CINE, next ? "1" : "0");
        // Sonification only while Cinema is on, created on this user gesture.
        if (next) audio.start();
        else audio.stop();
        if (field) field.refreshColors();
      };
    }

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeLogDrawer();
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else fallbackCopy(text);
  }
  function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }

  function openLogDrawer() {
    $("log-drawer").classList.add("open");
    $("log-drawer").setAttribute("aria-hidden", "false");
    fetchLog();
    if (logTimer) clearInterval(logTimer);
    logTimer = setInterval(fetchLog, 3000);
  }
  function closeLogDrawer() {
    $("log-drawer").classList.remove("open");
    $("log-drawer").setAttribute("aria-hidden", "true");
    if (logTimer) {
      clearInterval(logTimer);
      logTimer = null;
    }
  }

  async function fetchLog() {
    if (!selectedDispatch || !lastState) return;
    const q = new URLSearchParams({
      swarm: lastState._logSwarm || lastState.swarmId || "",
      dispatch: selectedDispatch,
      format: "structured",
      lines: "80",
    });
    try {
      const res = await fetch("/api/log-tail?" + q, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      $("log-title").textContent = "Log · " + (data.dispatchId || selectedDispatch);
      const body = $("log-body");
      const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
      const items = data.events || data.lines || [];
      // Content-based freshness: the tail window shifts, so index math would
      // re-animate old lines on every refresh. Compare against last render.
      if (logSeenDispatch !== selectedDispatch) {
        logSeenDispatch = selectedDispatch;
        logSeenCount = 0;
        window.__logPrevSet = null;
      }
      // Strip ANSI escapes + control chars — raw builder logs are terminal
      // output and render as gibberish otherwise (mobile log sheet bug).
      const cleanLine = (s) =>
        String(s)
          .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
          .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
          .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
      const lineText = (ev) =>
        cleanLine(typeof ev === "string" ? ev : ev.data || ev.text || JSON.stringify(ev));
      const prevSet = window.__logPrevSet;
      body.innerHTML =
        items
          .map((ev, i) => {
            const fresh =
              prevSet && !prevSet.has(lineText(ev)) ? " line-in" : "";
            if (typeof ev === "string") {
              const warn = /\bwarn(ing)?\b/i.test(ev) ? " warn" : "";
              return '<div class="log-line raw' + warn + fresh + '">' + esc(ev) + "</div>";
            }
            const text = ev.data || ev.text || JSON.stringify(ev);
            let cls =
              ev.type === "thought"
                ? "thought"
                : ev.type === "error"
                  ? "error"
                  : ev.type === "raw"
                    ? "raw"
                    : "";
            if (!cls && /\bwarn(ing)?\b/i.test(String(text))) cls = "warn";
            return (
              '<div class="log-line ' +
              cls +
              fresh +
              '">' +
              esc(text) +
              "</div>"
            );
          })
          .join("") || '<div class="empty">No log lines yet</div>';
      logSeenCount = items.length;
      window.__logPrevSet = new Set(items.map(lineText));
      if (stickLogBottom || atBottom) body.scrollTop = body.scrollHeight;
    } catch {
      $("log-body").innerHTML = '<div class="empty">Could not load log</div>';
    }
  }

  async function loadRegistry() {
    try {
      const res = await fetch("/api/swarms", { cache: "no-store" });
      if (res.ok) registry = await res.json();
    } catch {
      /* ok */
    }
    renderSwarmTabs();
  }

  function renderSwarmTabs() {
    const tabs = $("swarm-tabs");
    if (!tabs) return;
    if (!registry.swarms || registry.swarms.length <= 1) {
      tabs.hidden = true;
      return;
    }
    tabs.hidden = false;
    if (!selectedSwarm) selectedSwarm = registry.default || registry.swarms[0].id;
    tabs.innerHTML = registry.swarms
      .map((s) => {
        let label = s.title || s.id;
        if (label.length > 28) {
          const m = label.match(/#\d+(?:\+#\d+)?/);
          label = m
            ? m[0] + " · " + label.replace(/^.*?·\s*/, "").slice(0, 18)
            : label.slice(0, 26) + "…";
        }
        const idm = (s.id || "").match(/iss-(\d+(?:-\d+)*)/);
        if (isNarrow() && idm) label = "#" + idm[1].replace(/-/g, "/");
        if (s.id === "default" || s.id === registry.default)
          label = isNarrow() ? "Main" : "Main · all packs";
        return (
          '<button type="button" class="tab' +
          (s.id === selectedSwarm ? " active" : "") +
          '" data-swarm="' +
          esc(s.id) +
          '">' +
          esc(label) +
          "</button>"
        );
      })
      .join("");
    tabs.querySelectorAll(".tab").forEach((btn) => {
      btn.onclick = () => {
        const go = () => {
          selectedSwarm = btn.dataset.swarm;
          localStorage.setItem(LS_SWARM, selectedSwarm);
          renderSwarmTabs();
          pollState();
        };
        if (document.startViewTransition) document.startViewTransition(go);
        else go();
      };
    });
  }

  function runCardHtml(r) {
    const pack = shortSwarm(r.swarmId, r.swarmTitle);
    return (
      '<div class="run-card' +
      (selectedDispatch === r.id ? " selected" : "") +
      '" data-dispatch="' +
      esc(r.id) +
      '" data-swarm="' +
      esc(r.swarmId || "") +
      '">' +
      '<div style="font-weight:600">' +
      esc(r.agentLabel || "?") +
      (r.pidAlive === false ? ' <span class="warn">exited?</span>' : "") +
      (pack ? ' <span class="pill" style="margin:0 0 0 4px">' + esc(pack) + "</span>" : "") +
      "</div>" +
      '<div style="color:var(--fg-2);margin-top:2px">' +
      esc(r.taskTitle || r.taskId) +
      "</div>" +
      '<div style="color:var(--fg-3);font-family:var(--mono);font-size:12px;margin-top:6px">' +
      fmtDur(r.elapsedMs) +
      (r.worktree ? " · " + esc(r.worktree) : "") +
      "</div></div>"
    );
  }

  function wireRunCards(root, s) {
    if (!root) return;
    root.querySelectorAll(".run-card").forEach((el) => {
      el.onclick = () => {
        selectedDispatch = el.dataset.dispatch;
        const packSwarm = el.dataset.swarm;
        if (packSwarm) {
          lastState = Object.assign({}, lastState || s || {}, {
            swarmId: packSwarm,
            _logSwarm: packSwarm,
          });
        }
        if (isNarrow()) setMobileView("runs");
        openLogDrawer();
        renderSide(lastState || s);
      };
    });
  }

  function renderStats(s) {
    const st = s.stats || {
      done: 0,
      total: 0,
      pct: 0,
      counts: {},
      runningDispatches: 0,
    };
    const c = st.counts || {};
    const liveN = (s.runningDispatches || []).length || st.runningDispatches || 0;
    $("stats").classList.remove("is-loading");
    $("stats").innerHTML = [
      ["Live", liveN],
      ["Building", c.building || 0],
      ["Blocked", c.blocked || 0],
      ["Review", c.review || 0],
      ["Queued", (c.open || 0) + (c.assigned || 0)],
      ["Done", st.done],
      ["Total", st.total],
    ]
      .map(([label, val]) => {
        const hot = (label === "Blocked" && val > 0) || (label === "Live" && val > 0);
        const tone =
          label === "Blocked" && val > 0
            ? "color:var(--red)"
            : label === "Live" && val > 0
              ? "color:var(--blue)"
              : "";
        // Real poll history → CSS-only sparkline (clip-path polygon, no canvas)
        const hist = statHistory[label] || (statHistory[label] = []);
        const changed = hist.length && hist[hist.length - 1] !== val;
        hist.push(val);
        if (hist.length > 24) hist.shift();
        let spark = "";
        if (hist.length > 2) {
          const max = Math.max(...hist, 1);
          const pts = hist
            .map((v, i) => {
              const x = (i / (hist.length - 1)) * 100;
              const y = 100 - (v / max) * 100;
              return x.toFixed(1) + "% " + y.toFixed(1) + "%";
            })
            .join(",");
          spark =
            '<i class="spark" style="clip-path:polygon(0% 100%,' +
            pts +
            ',100% 100%)"></i>';
        }
        return (
          '<div class="stat' +
          (hot ? " hot" : "") +
          (changed ? " tick" : "") +
          '">' +
          spark +
          '<b style="' +
          tone +
          '">' +
          val +
          "</b><span>" +
          label +
          "</span></div>"
        );
      })
      .join("");

    document.documentElement.style.setProperty("--progress", (st.pct || 0) + "%");
    const bar = $("bar");
    if (bar) {
      bar.style.width = (st.pct || 0) + "%";
      bar.classList.toggle("done", st.pct === 100 && st.total > 0);
    }
    let barExtra = st.total
      ? st.done + " / " + st.total + " (" + st.pct + "%)"
      : "No active tasks";
    if (s.swarmId === "overview") barExtra += " · mission";
    if (s.eta && s.eta.estimatedMsLeft) barExtra += " · eta ~" + fmtDur(s.eta.estimatedMsLeft);
    if ($("bar-label")) $("bar-label").textContent = barExtra;

    // Live ETA ring: real estimate from /api/state, ticking down between polls
    const ring = $("eta-ring");
    if (ring) {
      const active = s.eta && s.eta.estimatedMsLeft && st.pct < 100;
      if (active) {
        etaTargetTs = Date.now() + s.eta.estimatedMsLeft;
        ring.hidden = false;
        updateEtaRing();
        if (!etaTicker) etaTicker = setInterval(updateEtaRing, 1000);
      } else {
        ring.hidden = true;
        etaTargetTs = 0;
        if (etaTicker) {
          clearInterval(etaTicker);
          etaTicker = null;
        }
      }
    }

    const thisComplete = !!(st.total && st.done === st.total);
    const celeb = $("celebrate");
    if (celeb) {
      if (thisComplete && !window.__megaBusy) {
        celeb.hidden = false;
        celeb.textContent = "All tracked tasks done";
        celeb.style.color = "var(--green)";
      } else if (thisComplete && window.__megaBusy) {
        celeb.hidden = false;
        celeb.textContent = "This view complete - packs still running";
        celeb.style.color = "var(--amber)";
      } else celeb.hidden = true;
    }

    pushFieldTelemetry(s);
  }

  function updateEtaRing() {
    const count = $("eta-count");
    if (!count || !etaTargetTs) return;
    const left = etaTargetTs - Date.now();
    count.textContent = left > 0 ? fmtDur(left) : "now";
  }

  function pushFieldTelemetry(s) {
    if (!field) return;
    const st = s.stats || {};
    const c = st.counts || {};
    const live = (s.runningDispatches || []).length || st.runningDispatches || 0;
    const ram = s.hostMemory && s.hostMemory.pctUsed != null ? s.hostMemory.pctUsed : 30;
    field.setTelemetry({
      live,
      building: c.building || 0,
      review: c.review || 0,
      blocked: c.blocked || 0,
      ramPct: ram,
      progressPct: st.pct || 0,
    });
    const statuses = {};
    for (const t of s.tasks || []) statuses[t.id] = t.status;
    field.setClusters(s.runningDispatches || [], statuses);
    audio.setLive(live);
  }

  function renderHostMemory(s) {
    let el = $("mem-banner");
    if (!el) {
      const stats = $("stats");
      const mount = document.createElement("div");
      mount.id = "mem-banner";
      mount.className = "banner mem-ok";
      mount.innerHTML =
        '<div class="mem-head"><div id="mem-label">Host RAM</div><div id="mem-pct" class="mem-pct"></div></div>' +
        '<div class="mem-bar-outer"><div class="mem-bar-inner" id="mem-bar"></div></div>' +
        '<div id="mem-detail" class="mem-detail"></div>';
      if (stats && stats.parentNode) stats.parentNode.insertBefore(mount, stats.nextSibling);
      el = mount;
    }
    const hm = s && s.hostMemory;
    if (!hm || hm.totalGb == null) {
      el.hidden = false;
      el.className = "banner mem-warn";
      if ($("mem-label")) $("mem-label").textContent = "Host RAM";
      if ($("mem-detail")) $("mem-detail").textContent = "Waiting for host metrics...";
      return;
    }
    const thr = hm.minFreeGb != null ? hm.minFreeGb : 2;
    const low = !!hm.low || hm.availableGb < thr;
    const warn = !low && hm.availableGb < thr * 1.5;
    el.hidden = false;
    el.className = "banner " + (low ? "mem-crit" : warn ? "mem-warn" : "mem-ok");
    if ($("mem-label")) {
      $("mem-label").textContent =
        (low ? "Low RAM - auto-pause may fire" : "Host RAM") +
        (hm.autoPaused || (s.memoryGuard && s.memoryGuard.triggered) ? " · AUTO-PAUSED" : "");
    }
    if ($("mem-pct")) $("mem-pct").textContent = (hm.pctUsed != null ? hm.pctUsed : "?") + "% used";
    if ($("mem-detail")) {
      $("mem-detail").textContent =
        "used " +
        hm.usedGb +
        " / " +
        hm.totalGb +
        " G  ·  available " +
        hm.availableGb +
        " G  ·  free " +
        hm.freeGb +
        " G  ·  kill if avail < " +
        thr +
        " G";
    }
    document.documentElement.style.setProperty("--ram", Math.min(100, Number(hm.pctUsed) || 0) + "%");
    const bar = $("mem-bar");
    if (bar) {
      bar.style.width = Math.min(100, Number(hm.pctUsed) || 0) + "%";
      bar.className = "mem-bar-inner" + (low ? " crit" : warn ? " warn" : "");
    }
  }

  function renderHeader(s) {
    const sid = s.swarmId === "overview" ? "all packs" : s.swarmId;
    if ($("subtitle"))
      $("subtitle").textContent = [s.repoName, sid].filter(Boolean).join(" · ") || "-";
    if ($("goal-title")) $("goal-title").textContent = s.goal ? s.goal.title : "No goal set";
  }

  function renderHealth(s) {
    const h = s.boardHealth;
    if (!h || h.ok) {
      if ($("health-banner")) $("health-banner").hidden = true;
      return;
    }
    $("health-banner").hidden = false;
    $("health-banner").className = "banner bad";
    $("health-banner").textContent =
      "Board health: " + (h.problems || []).map((p) => p.message || p.kind).join(" · ");
  }

  function renderPause(s) {
    if (!$("pause-banner")) return;
    if (!s.paused) {
      $("pause-banner").hidden = true;
      return;
    }
    $("pause-banner").hidden = false;
    const n = (s.paused.interrupted || []).length;
    $("pause-banner").textContent =
      "Paused" +
      (s.paused.reason ? ": " + s.paused.reason : "") +
      " since " +
      new Date(s.paused.pausedAt).toLocaleString() +
      (n ? " · " + n + " interrupted run(s)" : "");
  }

  function vtName(id) {
    return "t-" + String(id || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  function taskCard(t, byId, s, runningIds) {
    const glow = runningIds.has(t.id) ? " building-glow" : "";
    const blocked = t.status === "blocked" ? " blocked" : "";
    const st = statusTone(t.status);
    const fm = flashMarks[t.id];
    const flash = fm && fm.until > Date.now() ? " " + fm.cls : "";
    const pack =
      t.swarmId && t.swarmId !== "overview"
        ? '<span class="pill">' + esc(shortSwarm(t.swarmId, t.swarmTitle)) + "</span>"
        : "";
    return (
      '<div class="card' +
      glow +
      blocked +
      flash +
      '" data-task="' +
      esc(t.id) +
      '" style="view-transition-name:' +
      vtName(t.id) +
      '">' +
      '<div class="title">' +
      esc(t.title) +
      "</div>" +
      '<div class="friendly">' +
      esc(friendly(t, byId, s.friendlyStatus)) +
      "</div>" +
      '<span class="pill" style="color:' +
      st.c +
      ";background:" +
      st.bg +
      '">' +
      esc(t.status) +
      "</span>" +
      (t.ownerAgentLabel ? '<span class="pill">' + esc(t.ownerAgentLabel) + "</span>" : "") +
      pack +
      "</div>"
    );
  }

  function renderKanban(s) {
    const tasks = (s.tasks || []).filter((t) => t.status !== "cancelled");
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const runningIds = new Set((s.runningDispatches || []).map((r) => r.taskId));
    const cols = [
      ["Queued", tasks.filter((t) => t.status === "open" || t.status === "assigned")],
      ["Building", tasks.filter((t) => t.status === "planning" || t.status === "building")],
      ["Review", tasks.filter((t) => t.status === "review")],
      ["Blocked", tasks.filter((t) => t.status === "blocked")],
      ["Done", tasks.filter((t) => t.status === "done")],
    ];
    const narrow = isNarrow();
    const use = narrow ? cols.filter(([, list]) => list.length > 0) : cols;
    const final = use.length ? use : cols;
    $("kanban-view").innerHTML = final
      .map(
        ([name, list]) =>
          '<div class="col"><h3><span>' +
          name +
          '</span><span style="font-family:var(--mono)">' +
          list.length +
          "</span></h3>" +
          (list.length
            ? list.map((t) => taskCard(t, byId, s, runningIds)).join("")
            : '<div class="empty">Empty</div>') +
          "</div>",
      )
      .join("");
  }

  function renderTimeline(s) {
    const tasks = [...(s.tasks || [])]
      .filter((t) => t.status !== "cancelled")
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const byId = new Map(tasks.map((t) => [t.id, t]));
    $("timeline-view").innerHTML = tasks.length
      ? tasks
          .map((t) => {
            const st = statusTone(t.status);
            return (
              '<div class="card"><div class="title">' +
              esc(t.title) +
              '</div><div class="friendly">' +
              esc(friendly(t, byId, s.friendlyStatus)) +
              '</div><span class="pill" style="color:' +
              st.c +
              ";background:" +
              st.bg +
              '">' +
              esc(t.status) +
              "</span></div>"
            );
          })
          .join("")
      : '<div class="empty">No tasks</div>';
  }

  function renderMain(s) {
    if (viewMode === "kanban") renderKanban(s);
    else renderTimeline(s);
  }

  function renderSide(s) {
    const runs = s.runningDispatches || [];
    const runsHtml = runs.length
      ? runs.map(runCardHtml).join("")
      : '<div class="empty">No live dispatches on this view</div>';
    if ($("live-runs")) $("live-runs").innerHTML = runsHtml;
    const hero = $("hero-runs");
    if (hero) {
      const NOW_PREVIEW = 3;
      const allRuns = runs.slice();
      const shown = window.__nowExpanded ? allRuns : allRuns.slice(0, NOW_PREVIEW);
      hero.innerHTML = shown.length
        ? shown.map(runCardHtml).join("")
        : '<div class="empty">No live dispatches on this view</div>';
      const more = $("now-more");
      if (more) {
        if (allRuns.length > NOW_PREVIEW) {
          more.hidden = false;
          more.textContent = window.__nowExpanded
            ? "Show less"
            : "Show all " + allRuns.length + " runs";
        } else more.hidden = true;
      }
    }
    wireRunCards($("live-runs"), s);
    wireRunCards(hero, s);

    const blocked = (s.tasks || []).filter((t) => t.status === "blocked");
    const hb = $("hero-blocked");
    const nm = $("now-meta");
    if (nm) {
      nm.textContent =
        (runs.length
          ? runs.length + " live"
          : s.stats && s.stats.coordinatorLag
            ? "coord lag (not paused)"
            : "idle") +
        (blocked.length ? " · " + blocked.length + " blocked" : "");
    }
    if (hb) {
      if (!blocked.length) {
        hb.hidden = true;
        hb.innerHTML = "";
      } else {
        hb.hidden = false;
        hb.innerHTML =
          '<div style="font-size:12px;font-weight:600;color:var(--red);margin-bottom:6px">Blocked</div>' +
          blocked
            .map(
              (t) =>
                '<div class="card blocked"><div class="title">' +
                esc(t.title) +
                '</div><div class="friendly">' +
                esc(t.blockedReason || "needs help") +
                "</div></div>",
            )
            .join("");
      }
    }

    const hist = s.dispatchHistory || [];
    if ($("dispatch-hist")) {
      $("dispatch-hist").innerHTML = hist.length
        ? hist
            .map(
              (r) =>
                '<div class="hist">' +
                esc(r.agentLabel || "?") +
                " · " +
                esc(r.taskTitle || r.taskId) +
                " · " +
                esc(r.status) +
                " · " +
                fmtDur(r.elapsedMs) +
                "</div>",
            )
            .join("")
        : '<div class="empty">No history yet</div>';
    }
    const agents = s.agentWorkload || s.agents || [];
    if ($("agents")) {
      $("agents").innerHTML = agents.length
        ? agents
            .map(
              (a) =>
                '<div class="hist"><b style="color:var(--fg)">' +
                esc(a.label) +
                "</b> · active " +
                (a.active || 0) +
                " · done " +
                (a.done || 0) +
                "</div>",
            )
            .join("")
        : '<div class="empty">No agents</div>';
    }
  }

  function relTime(ts) {
    if (!ts) return "";
    const d = Date.now() - ts;
    if (d < 60000) return Math.max(1, Math.floor(d / 1000)) + "s ago";
    if (d < 3600000) return Math.floor(d / 60000) + "m ago";
    if (d < 86400000) return Math.floor(d / 3600000) + "h ago";
    return Math.floor(d / 86400000) + "d ago";
  }

  let lastActivityTs = 0;
  function renderActivity(s) {
    const el = $("activity");
    if (!el) return;
    const feed = s.activityFeed || [];
    if (!feed.length) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const items = feed.slice(0, 6);
    const newest = items[0] && items[0].timestamp ? items[0].timestamp : 0;
    el.innerHTML =
      '<div class="act-head">Activity</div>' +
      items
        .map((ev) => {
          const isNew = ev.timestamp && ev.timestamp > lastActivityTs;
          const tone =
            ev.status === "done"
              ? "act-done"
              : ev.status === "blocked"
                ? "act-blocked"
                : ev.type === "note"
                  ? "act-note"
                  : "";
          return (
            '<div class="act-item ' +
            tone +
            (isNew ? " is-new" : "") +
            '"><b>' +
            esc(ev.agentLabel || "?") +
            "</b> " +
            esc(ev.text || "") +
            '<span class="act-time">' +
            relTime(ev.timestamp) +
            "</span></div>"
          );
        })
        .join("");
    if (newest) lastActivityTs = Math.max(lastActivityTs, newest);
  }

  // Task detail popover — native popover + CSS anchor positioning, all real data.
  function showTaskPopover(taskId, cardEl) {
    const pop = $("task-pop");
    if (!pop || !lastState) return;
    const t = (lastState.tasks || []).find((x) => x.id === taskId);
    if (!t) return;
    const byId = new Map((lastState.tasks || []).map((x) => [x.id, x]));
    const st = statusTone(t.status);
    const deps = (t.dependsOn || []).map((d) => {
      const dep = byId.get(d);
      return (
        '<span class="pill" style="' +
        (dep && dep.status === "done" ? "color:var(--green)" : "color:var(--amber)") +
        '">' +
        esc(dep ? dep.title || d : d) +
        "</span>"
      );
    });
    const files = (t.ownedFiles || []).slice(0, 8);
    pop.innerHTML =
      '<div class="tp-title">' +
      esc(t.title) +
      "</div>" +
      '<div class="tp-row"><span class="pill" style="color:' +
      st.c +
      ";background:" +
      st.bg +
      '">' +
      esc(t.status) +
      "</span>" +
      (t.ownerAgentLabel ? '<span class="pill">' + esc(t.ownerAgentLabel) + "</span>" : "") +
      "</div>" +
      '<div class="tp-friendly">' +
      esc(friendly(t, byId, lastState.friendlyStatus)) +
      "</div>" +
      (t.blockedReason
        ? '<div class="tp-block">Blocked: ' + esc(t.blockedReason) + "</div>"
        : "") +
      (deps.length ? '<div class="tp-sec">Depends on</div><div>' + deps.join("") + "</div>" : "") +
      (files.length
        ? '<div class="tp-sec">Owned files</div><div class="tp-files">' +
          files.map((f) => esc(f)).join("<br>") +
          "</div>"
        : "") +
      '<div class="tp-meta">' +
      [
        t.createdAt ? "created " + relTime(t.createdAt) : "",
        t.updatedAt ? "updated " + relTime(t.updatedAt) : "",
        t.completedAt ? "completed " + relTime(t.completedAt) : "",
      ]
        .filter(Boolean)
        .join(" · ") +
      "</div>";
    document.querySelectorAll(".card[data-task]").forEach((c) => {
      c.style.anchorName = "";
    });
    cardEl.style.anchorName = "--task-current";
    try {
      pop.showPopover();
    } catch {
      /* already open */
    }
  }

  function wireTaskPopover() {
    const main = $("main-view");
    if (!main) return;
    main.addEventListener("click", (e) => {
      const card = e.target.closest && e.target.closest(".card[data-task]");
      if (!card) return;
      showTaskPopover(card.getAttribute("data-task"), card);
    });
  }

  function packStateClass(sw) {
    const st = sw.stats || {};
    const c = st.counts || {};
    const building = c.building || sw.building || 0;
    const review = c.review || sw.review || 0;
    const live = sw.live || st.runningDispatches || 0;
    const done = st.done || 0;
    const total = st.total || 1;
    const blocked = c.blocked || 0;
    if (blocked) return "is-blocked";
    if (building || live) return "is-building";
    if (review) return "is-review";
    if (total > 0 && done >= total) return "is-done";
    return "";
  }

  function renderOrbit(packs) {
    const orbit = $("constel-orbit");
    if (!orbit) return;
    if (!packs.length) {
      orbit.innerHTML = "";
      return;
    }
    const n = packs.length;
    const nodes = packs
      .map((sw, i) => {
        const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
        // Two ring radii for visual depth
        const ring = i % 2 === 0 ? 38 : 58;
        const x = 50 + Math.cos(ang) * ring;
        const y = 50 + Math.sin(ang) * ring;
        const cls = packStateClass(sw);
        return (
          '<span class="orbit-node ' +
          cls +
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
    orbit.innerHTML = '<span class="orbit-core"></span>' + nodes;
    orbit.querySelectorAll(".orbit-node").forEach((el) => {
      el.onclick = () => {
        const go = () => {
          selectedSwarm = el.dataset.swarm;
          localStorage.setItem(LS_SWARM, selectedSwarm);
          renderSwarmTabs();
          pollState();
        };
        if (document.startViewTransition) document.startViewTransition(go);
        else go();
      };
      el.style.cursor = "pointer";
    });
  }

  function renderConstellation(s) {
    const panel = $("constellation");
    const body = $("constel-grid");
    if (!panel || !body) return;
    const ov = s._overview;
    const packs = (ov && ov.swarms ? ov.swarms : []).filter((sw) => !sw.isDefault);
    if (!packs.length) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    const livePacks = packs.filter((sw) => (sw.live || 0) > 0 || (sw.building || 0) > 0).length;
    const donePacks = packs.filter((sw) => {
      const st = sw.stats || {};
      return st.total > 0 && st.done >= st.total;
    }).length;
    const hint = $("constel-hint");
    if (hint) {
      hint.textContent =
        packs.length +
        " packs · " +
        donePacks +
        " done" +
        (livePacks ? " · " + livePacks + " live" : "");
    }
    renderOrbit(packs);
    body.innerHTML = packs
      .map((sw) => {
        const st = sw.stats || {};
        const c = st.counts || {};
        const building = c.building || sw.building || 0;
        const review = c.review || sw.review || 0;
        const live = sw.live || st.runningDispatches || 0;
        const done = st.done || 0;
        const total = st.total || 1;
        const pct = total ? Math.round((done / total) * 100) : building ? 60 : review ? 85 : 20;
        let cls = "pack-node " + packStateClass(sw);
        const title = (sw.title || sw.id).replace(/^#/, "#");
        const short = shortSwarm(sw.id, title);
        return (
          '<button type="button" class="' +
          cls.trim() +
          '" data-swarm="' +
          esc(sw.id) +
          '">' +
          '<div class="pn-title">' +
          esc(short || title) +
          "</div>" +
          '<div class="pn-ring"><div class="pn-fill" style="width:' +
          pct +
          '%"></div></div>' +
          '<div class="pn-meta">' +
          (live ? live + " live · " : "") +
          (building ? building + " build · " : "") +
          (review ? review + " review" : done === total && total > 0 ? "done" : "active") +
          "</div></button>"
        );
      })
      .join("");
    body.querySelectorAll(".pack-node").forEach((btn) => {
      btn.onclick = () => {
        const go = () => {
          selectedSwarm = btn.dataset.swarm;
          localStorage.setItem(LS_SWARM, selectedSwarm);
          renderSwarmTabs();
          pollState();
        };
        if (document.startViewTransition) document.startViewTransition(go);
        else go();
      };
    });
  }

  function render(s) {
    lastState = s;

    // Status-transition choreography: diff against last poll, fire real-event
    // pulses (shader shockwave + card flash + optional chime) and glide cards
    // between kanban columns with a named View Transition.
    const changed = [];
    for (const t of s.tasks || []) {
      const prev = taskStatuses[t.id];
      if (prev && prev !== t.status) changed.push({ id: t.id, to: t.status });
    }
    taskStatuses = {};
    for (const t of s.tasks || []) taskStatuses[t.id] = t.status;
    for (const ch of changed) {
      if (ch.to === "done") {
        if (field) field.pulse("done", ch.id);
        flashMarks[ch.id] = { cls: "just-done", until: Date.now() + 5000 };
        audio.chime();
      } else if (ch.to === "blocked") {
        if (field) field.pulse("blocked", ch.id);
        flashMarks[ch.id] = { cls: "just-blocked", until: Date.now() + 5000 };
      }
    }

    renderHeader(s);
    renderHealth(s);
    renderPause(s);
    renderHostMemory(s);
    renderStats(s);
    if (changed.length && document.startViewTransition && !document.hidden) {
      document.startViewTransition(() => renderMain(s));
    } else {
      renderMain(s);
    }
    renderSide(s);
    renderActivity(s);
    renderConstellation(s);
    if (!selectedDispatch && (s.runningDispatches || []).length) {
      selectedDispatch = s.runningDispatches[0].id;
    }
    const liveN = (s.runningDispatches || []).length;
    if ($("dot")) {
      $("dot").classList.toggle("live", liveN > 0);
      $("dot").classList.remove("stale");
    }
    const mem = s.hostMemory ? " · RAM " + s.hostMemory.availableGb + "G avail" : "";
    if ($("footer")) {
      $("footer").textContent =
        "Updated " +
        new Date(s.updatedAt).toLocaleTimeString() +
        " · poll " +
        pollIntervalMs(s) / 1000 +
        "s" +
        mem;
    }
  }

  function pollIntervalMs(s) {
    if (document.hidden) return 0;
    if (!s) return 2000;
    const st = s.stats || {};
    const active =
      (s.runningDispatches || []).length > 0 || (st.total || 0) > (st.done || 0);
    return active ? 2000 : 5000;
  }

  function isMissionRootSwarm(id) {
    return !id || id === "default" || id === (registry.default || "default");
  }
  function hasPeerPacks() {
    return (registry.swarms || []).some((s) => s.id !== (registry.default || "default"));
  }

  async function pollMega() {
    try {
      const res = await fetch("/api/mega", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const megas = data.megas || [];
      window.__megaBusy = megas.some((m) => (m.state && m.state.status) === "running");
      if ($("mega-panel") && $("mega-body")) {
        if (!megas.length) {
          $("mega-panel").hidden = true;
          return;
        }
        // Constellation replaces mega text panel when overview has packs
        $("mega-panel").hidden = true;
      }
    } catch {
      /* optional */
    }
  }

  async function pollState() {
    if (document.hidden) return;
    try {
      const useOverview = isMissionRootSwarm(selectedSwarm) && hasPeerPacks();
      let s;
      if (useOverview) {
        const res = await fetch("/api/state?view=overview", { cache: "no-store" });
        if (!res.ok) throw new Error(res.status);
        const ov = await res.json();
        s = {
          apiVersion: ov.apiVersion,
          swarmId: "overview",
          repoName: ov.repoName,
          updatedAt: ov.updatedAt,
          goal: ov.goal || { title: "Mission overview (all packs)", status: "active" },
          stats: ov.aggregate || ov.stats,
          runningDispatches: ov.runningDispatches || [],
          tasks: (ov.activeTasks || []).map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            ownerAgentLabel: t.ownerAgentLabel,
            blockedReason: t.blockedReason,
            swarmId: t.swarmId,
            swarmTitle: t.swarmTitle,
            ownedFiles: [],
          })),
          agents: [],
          dispatches: ov.runningDispatches || [],
          hostMemory: ov.hostMemory,
          memoryGuard: ov.memoryGuard,
          boardHealth: { ok: true },
          friendlyStatus: {},
          dispatchHistory: [],
          _overview: ov,
        };
        window.__swarmSnaps = {};
        for (const sw of ov.swarms || []) {
          window.__swarmSnaps[sw.id] = {
            total: sw.stats ? sw.stats.total : 0,
            done: sw.stats ? sw.stats.done : 0,
            live: sw.live || (sw.stats && sw.stats.runningDispatches) || 0,
          };
        }
      } else {
        const q = selectedSwarm ? "?swarm=" + encodeURIComponent(selectedSwarm) : "";
        const res = await fetch("/api/state" + q, { cache: "no-store" });
        if (!res.ok) throw new Error(res.status);
        s = await res.json();
      }
      if (s.updatedAt !== lastUpdatedAt || useOverview) {
        lastUpdatedAt = s.updatedAt;
        render(s);
      } else if (lastState) {
        renderSide(lastState);
        if ($("footer"))
          $("footer").textContent =
            "Updated " + new Date(s.updatedAt).toLocaleTimeString() + " · timers only";
      }
      failures = 0;
      if ($("dot")) $("dot").classList.remove("stale");
      pollMega();
      schedulePoll(s);
    } catch {
      failures += 1;
      if (failures >= 3) {
        if ($("dot")) $("dot").classList.add("stale");
        if ($("footer"))
          $("footer").textContent = "Connection lost. Is the dashboard process running?";
        const hb = $("health-banner");
        if (hb) {
          hb.hidden = false;
          hb.className = "banner bad";
          hb.textContent =
            "Cannot reach /api/state. Reopen this page or restart: swarm dashboard --daemon --port 4599";
        }
      }
      schedulePoll(lastState);
    }
  }

  function schedulePoll(s) {
    if (pollTimer) clearTimeout(pollTimer);
    const ms = pollIntervalMs(s);
    if (ms > 0) pollTimer = setTimeout(pollState, ms);
  }

  function initField() {
    const canvas = $("gl-canvas");
    const fallback = $("field-fallback");
    if (!canvas || typeof MissionField === "undefined") {
      if (fallback) fallback.classList.add("is-on");
      return;
    }
    field = new MissionField(canvas);
    if (!field._ok) {
      if (fallback) fallback.classList.add("is-on");
      return;
    }
    field.start();
    window.addEventListener("resize", () => field && field.resize());
    if (typeof matchMedia === "function") {
      matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
        if (field) field.refreshColors();
      });
    }
    document.addEventListener("visibilitychange", () => {
      if (!field) return;
      if (document.hidden) field.stop();
      else field.start();
    });
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (pollTimer) clearTimeout(pollTimer);
    } else pollState();
  });

  wireChrome();
  wireTaskPopover();
  initField();
  loadRegistry().then(pollState);
})();
