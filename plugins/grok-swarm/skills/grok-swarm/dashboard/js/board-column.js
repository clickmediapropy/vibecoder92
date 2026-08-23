/**
 * Kanban column mapping for Mission Control.
 * Pure (no DOM). Browser: window/globalThis.SwarmBoardColumn.
 * Node tests load this same file via vm (see bin/dashboard-board-column.test.mjs).
 *
 * Logger (and other post-merge roles) run after the task is already `done`.
 * The board still has to show that live work in an active column — not buried
 * in Done — even though task status stays `done`.
 */
(function (root) {
  "use strict";

  function roleFromAgentLabel(label) {
    var s = String(label || "").toLowerCase();
    if (s.indexOf("logger") !== -1) return "logger";
    if (s.indexOf("review") !== -1 || s.indexOf("visual") !== -1) return "reviewer";
    if (s.indexOf("scout") !== -1) return "scout";
    if (s.indexOf("coord") !== -1) return "coordinator";
    return "builder";
  }

  function boardColumnForStatus(status) {
    var st = String(status || "");
    if (st === "open" || st === "assigned") return "Queued";
    if (st === "planning" || st === "building") return "Building";
    if (st === "review") return "Review";
    if (st === "blocked") return "Blocked";
    if (st === "done") return "Done";
    if (st === "cancelled") return null;
    return "Queued";
  }

  function liveColumnForRole(role) {
    if (role === "coordinator") return null;
    if (role === "reviewer") return "Review";
    return "Building";
  }

  function boardColumnForTask(task, run) {
    if (run) {
      var live = liveColumnForRole(roleFromAgentLabel(run.agentLabel));
      if (live) return live;
    }
    return boardColumnForStatus(task && task.status);
  }

  function liveFriendly(run) {
    if (!run) return "";
    var who = run.agentLabel || "agent";
    var role = roleFromAgentLabel(who);
    if (role === "logger") return who + " is logging";
    if (role === "reviewer") return who + " is reviewing";
    if (role === "scout") return who + " is scouting";
    return who + " is building";
  }

  function pickRun(prev, next) {
    if (!prev) return next;
    if (roleFromAgentLabel(prev.agentLabel) === "coordinator") return next;
    return prev;
  }

  function bucketTasks(tasks, runs) {
    var buckets = { Queued: [], Building: [], Review: [], Blocked: [], Done: [] };
    var runByTask = {};
    (runs || []).forEach(function (r) {
      if (!r || !r.taskId) return;
      runByTask[r.taskId] = pickRun(runByTask[r.taskId], r);
    });
    var seen = {};
    (tasks || []).forEach(function (t) {
      if (!t || !t.id) return;
      var col = boardColumnForTask(t, runByTask[t.id]);
      if (!col || !buckets[col]) return;
      buckets[col].push(t);
      seen[t.id] = true;
    });
    (runs || []).forEach(function (r) {
      if (!r) return;
      if (r.taskId && seen[r.taskId]) return;
      var col = liveColumnForRole(roleFromAgentLabel(r.agentLabel));
      if (!col || !buckets[col]) return;
      buckets[col].push({
        id: r.taskId || r.id,
        title: r.taskTitle || r.agentLabel || "Live run",
        status: "building",
        ownerAgentLabel: r.agentLabel,
        synthetic: true,
        liveDispatch: r,
      });
      if (r.taskId) seen[r.taskId] = true;
    });
    Object.keys(buckets).forEach(function (name) {
      buckets[name].sort(function (a, b) {
        var al = !!(a.synthetic || runByTask[a.id]);
        var bl = !!(b.synthetic || runByTask[b.id]);
        if (al === bl) return 0;
        return al ? -1 : 1;
      });
    });
    return buckets;
  }

  function cardIsLive(t, runByTask) {
    if (!t) return false;
    if (t.synthetic) return true;
    var run = runByTask[t.id];
    if (!run) return false;
    return !!liveColumnForRole(roleFromAgentLabel(run.agentLabel));
  }

  /**
   * Phone kanban shows one column. Prefer the live overlay (logger/reviewer/builder)
   * so operators don't land on Queued while work is happening off-screen.
   */
  function preferredBoardColumn(buckets, runs) {
    var runByTask = {};
    (runs || []).forEach(function (r) {
      if (r && r.taskId) runByTask[r.taskId] = pickRun(runByTask[r.taskId], r);
    });
    var order = ["Queued", "Building", "Review", "Blocked", "Done"];
    var b = buckets || {};
    var i;
    for (i = 0; i < order.length; i++) {
      var liveList = b[order[i]] || [];
      if (
        liveList.some(function (t) {
          return cardIsLive(t, runByTask);
        })
      ) {
        return order[i];
      }
    }
    for (i = 0; i < order.length; i++) {
      if (order[i] === "Done") continue;
      if ((b[order[i]] || []).length) return order[i];
    }
    if ((b.Done || []).length) return "Done";
    return "";
  }

  var api = {
    roleFromAgentLabel: roleFromAgentLabel,
    boardColumnForStatus: boardColumnForStatus,
    liveColumnForRole: liveColumnForRole,
    boardColumnForTask: boardColumnForTask,
    liveFriendly: liveFriendly,
    bucketTasks: bucketTasks,
    preferredBoardColumn: preferredBoardColumn,
  };
  if (root) root.SwarmBoardColumn = api;
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
