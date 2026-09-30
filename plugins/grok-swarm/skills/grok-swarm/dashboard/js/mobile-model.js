/**
 * Mobile operator model for Mission Control.
 * Pure (no DOM). Browser: window/globalThis.SwarmMobileModel.
 * Node tests load this same file via vm (see bin/dashboard-mobile-model.test.mjs).
 *
 * ui.js asks this module what the phone chrome should say and allow:
 * the command bar state, the chat unread badge, which board column to show,
 * and how the chat thread groups into bubbles.
 */
(function (root) {
  "use strict";

  var STALE_MS = 12000; /* same threshold as the footer (ui.js renderFooter) */
  var COLUMNS = ["Queued", "Building", "Review", "Blocked", "Done"];
  /* What the operator most likely wants to see first. */
  var COLUMN_PRIORITY = ["Building", "Blocked", "Review", "Queued", "Done"];
  var SEP_GAP_MS = 15 * 60 * 1000;
  var CONTINUE_MS = 2 * 60 * 1000;

  function ts(m) {
    var v = m && m.timestamp;
    if (typeof v === "number") return v;
    var n = Date.parse(v);
    return isNaN(n) ? 0 : n;
  }

  /**
   * Command bar state. Button enable rules match the desktop control
   * segment (renderPause): Hold needs no pause, Pause needs no hard pause,
   * Resume needs a pause manifest.
   * @param paused  s.paused from /api/state (null | {noKill, reason, pausedAt, ...})
   * @param coordinatorAlive  /api/mail coordinatorAlive (true | false | null = unknown yet)
   * @param ageMs  time since the last state sync
   */
  function commandState(paused, coordinatorAlive, ageMs) {
    var p = paused || null;
    var hold = { enabled: !p, primary: false };
    var pause = { enabled: !(p && !p.noKill), primary: false };
    var resume = { enabled: !!p, primary: false };
    var tone, label, hint;
    if (p && p.noKill) {
      tone = "hold";
      label = "On hold";
      hint = "Running builders finish, nothing new starts";
      resume.primary = true;
    } else if (p) {
      tone = "paused";
      label = "Paused";
      hint = "Builders stopped, state kept";
      resume.primary = true;
    } else if (coordinatorAlive === false) {
      tone = "offline";
      label = "Coordinator off";
      hint = "Coordinator is not running";
    } else if (coordinatorAlive === true) {
      tone = "live";
      label = "Live";
      hint = "Coordinator is running";
      hold.primary = true;
    } else {
      tone = "unknown";
      label = "Connecting";
      hint = "";
    }
    var age = Number(ageMs) || 0;
    var stale = age > STALE_MS ? Math.floor(age / 1000) : 0;
    return {
      tone: tone,
      label: label,
      hint: hint,
      stale: stale,
      buttons: { hold: hold, pause: pause, resume: resume },
    };
  }

  /** Coordinator messages newer than the last time the Chat tab was open. */
  function unreadCount(messages, lastSeenTs) {
    var seen = Number(lastSeenTs) || 0;
    var n = 0;
    var alert = false;
    (messages || []).forEach(function (m) {
      if (!m || m.from === "Operator") return;
      if (ts(m) <= seen) return;
      n += 1;
      if (m.type === "escalation") alert = true;
    });
    return { n: n, alert: alert };
  }

  /** Board column the phone shows first. "" when the board is empty. */
  function defaultColumn(counts) {
    var c = counts || {};
    for (var i = 0; i < COLUMN_PRIORITY.length; i++) {
      if ((c[COLUMN_PRIORITY[i]] || 0) > 0) return COLUMN_PRIORITY[i];
    }
    return "";
  }

  /**
   * The operator's own pick wins while it still has cards; then the column
   * that holds live work; then defaultColumn.
   */
  function pickColumn(counts, userChoice, liveColumn) {
    var c = counts || {};
    if (userChoice && (c[userChoice] || 0) > 0) return userChoice;
    if (liveColumn && (c[liveColumn] || 0) > 0) return liveColumn;
    return defaultColumn(c);
  }

  /**
   * Chat thread rows, oldest first.
   * { sep: true, ts } rows mark a time break (first message, new day, or a
   * gap over 15 minutes). Message rows get kind me | them | notice and
   * `cont` when they continue the same sender's burst (no repeated name).
   */
  function groupMessages(messages) {
    var list = (messages || []).filter(Boolean).slice().sort(function (a, b) {
      return ts(a) - ts(b);
    });
    var out = [];
    var prev = null;
    list.forEach(function (m) {
      var t = ts(m);
      var kind = m.from === "Operator" ? "me" : m.type === "message" ? "them" : "notice";
      var newDay = prev && new Date(ts(prev)).toDateString() !== new Date(t).toDateString();
      if (!prev || newDay || t - ts(prev) > SEP_GAP_MS) out.push({ sep: true, ts: t });
      var cont =
        !!prev &&
        out[out.length - 1].sep !== true &&
        kind !== "notice" &&
        prev.from === m.from &&
        prev.to === m.to &&
        t - ts(prev) <= CONTINUE_MS;
      out.push({ sep: false, kind: kind, cont: cont, msg: m, ts: t });
      prev = m;
    });
    return out;
  }

  /** Card avatar text: "Builder Shell" -> "BS", "Reviewer" -> "RE", "" -> "". */
  function initials(label) {
    var words = String(label || "").trim().split(/[\s_\-]+/).filter(Boolean);
    if (!words.length) return "";
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  }

  /** Stable avatar hue (0-359) per owner, so the same agent keeps its color. */
  function ownerHue(label) {
    var s = String(label || "");
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  var api = {
    initials: initials,
    ownerHue: ownerHue,
    STALE_MS: STALE_MS,
    COLUMNS: COLUMNS,
    commandState: commandState,
    unreadCount: unreadCount,
    defaultColumn: defaultColumn,
    pickColumn: pickColumn,
    groupMessages: groupMessages,
  };
  if (root) root.SwarmMobileModel = api;
  if (typeof module === "object" && module && module.exports && typeof module.exports === "object") {
    try {
      Object.keys(api).forEach(function (k) {
        module.exports[k] = api[k];
      });
    } catch (err) {
      /* ESM interop: ignore */
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this);
