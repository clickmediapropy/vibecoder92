'use strict';

/**
 * Pure operator catalog for the Mission Control dashboard.
 * Commands are filled with the real repo/swarm so the user can copy-paste.
 */

function shellSingleQuote(s) {
  return "'" + String(s || '').replace(/'/g, "'\\''") + "'";
}

function buildOperatorGuide({
  repoRoot,
  swarmId,
  skillBin,
  workspace,
  registryRoot,
} = {}) {
  const repo = repoRoot || '$REPO';
  const sid = swarmId && swarmId !== 'default' ? swarmId : '';
  const swarmFlag = sid ? ' --swarm ' + sid : '';
  const exportSwarm = sid ? 'export SWARM_ID=' + sid + '\n' : '';
  const exportCoord = 'export SWARM_AGENT_NAME=Coordinator\n';
  const bin = skillBin || 'swarm';
  const dispatch = skillBin
    ? skillBin.replace(/\/swarm$/, '/dispatch-grok.sh')
    : 'dispatch-grok.sh';
  const guard = skillBin
    ? skillBin.replace(/\/swarm$/, '/coordinator-guard.sh')
    : 'coordinator-guard.sh';
  const qRepo = shellSingleQuote(repo);

  const sections = [
    {
      id: 'status',
      title: 'Status & watch',
      items: [
        {
          cmd: exportCoord + bin + ' board --sync' + swarmFlag,
          why: 'Refresh SWARM_BOARD.md from events (human board on disk).',
        },
        {
          cmd: bin + ' task list' + swarmFlag + ' --json',
          why: 'All tasks with status/owner/files (machine-readable).',
        },
        {
          cmd: bin + ' task ready' + swarmFlag,
          why: 'What can be dispatched now (open/assigned + deps done).',
        },
        {
          cmd: bin + ' dispatch list' + swarmFlag + ' --status running',
          why: 'Live builder/reviewer runs (PID, log, worktree).',
        },
        {
          cmd: bin + ' dispatch reconcile' + swarmFlag,
          why: 'Heal running+dead PID → done/failed from log end events.',
        },
        {
          cmd: bin + ' watch' + (sid ? ' ' + sid : ''),
          why: 'Terminal live board (no browser).',
        },
        {
          cmd: bin + ' check' + swarmFlag,
          why: 'Board validation: overlaps, missing deps, cycles. Exit 0 = clean.',
        },
      ],
    },
    {
      id: 'daemons',
      title: 'Daemons (dashboard / coordinator / heal)',
      items: [
        {
          cmd: 'cd ' + qRepo + ' && ' + exportCoord + bin + ' dashboard --daemon --open --port 4599',
          why: 'Start this Mission Control UI (detached pidfile).',
        },
        {
          cmd: bin + ' dashboard status',
          why: 'Is the dashboard process alive?',
        },
        {
          cmd: bin + ' coordinator status' + swarmFlag + ' --json',
          why: 'Coordinator daemon liveness + session.',
        },
        {
          cmd: bin + ' coordinator start --daemon --resume' + swarmFlag,
          why: 'Start/restart autonomous Grok coordinator (resume mode).',
        },
        {
          cmd: bin + ' coordinator stop' + swarmFlag,
          why: 'Stop the coordinator daemon.',
        },
        {
          cmd: bin + ' heal doctor --repo ' + qRepo + ' --json',
          why: 'Dry diagnosis (dead PIDs, stall, visual gates) with edgeIds.',
        },
        {
          cmd: bin + ' heal --daemon --interval 30 --repo ' + qRepo,
          why: 'Mechanical self-monitor (reconcile, restart daemons).',
        },
      ],
    },
    {
      id: 'dispatch',
      title: 'Dispatch builders (Mode A/B)',
      items: [
        {
          cmd:
            guard +
            ' --repo ' +
            qRepo +
            ' --expect-clean\n' +
            dispatch +
            ' --mode new --repo ' +
            qRepo +
            ' --worktree wt-domain --base "$(git -C ' +
            qRepo +
            ' rev-parse HEAD)" \\\n  --agent "Builder 1" --prompt-file /tmp/grok-swarm-prompt.md \\\n  --log /tmp/grok-swarm-domain.log',
          why:
            'Mode A: pre-create isolated worktree + launch worker (max-turns, role flags). Never raw grok --worktree alone.',
        },
        {
          cmd:
            dispatch +
            ' --mode existing --worktree-path "$WT_PATH" \\\n  --agent "Builder 1" --prompt-file /tmp/grok-swarm-prompt.md \\\n  --log /tmp/grok-swarm-domain.log',
          why: 'Mode B: continue inside an existing worktree (shell cwd = WT_PATH).',
        },
        {
          cmd:
            bin +
            ' dispatch record --task <task-id> --agent "Builder 1" \\\n  --worktree wt-domain --worktree-path "$WT_PATH" \\\n  --log /tmp/grok-swarm-domain.log --pid <PID> --base <REF> --verify-worktree' +
            swarmFlag,
          why: 'Record every run so the board/dashboard/fix-loop know the worktree + session.',
        },
        {
          cmd: bin + ' dispatch update --id <run-id> --status done --exit-code 0 --session <sessionId>' + swarmFlag,
          why: 'Mark a run finished and attach sessionId for Mode C resume.',
        },
      ],
    },
    {
      id: 'pause',
      title: 'Pause / resume',
      items: [
        {
          cmd: bin + ' pause --all --reason "operator halt"',
          why: 'Tree-kill builders + write pause.json with resume plan (safe halt).',
        },
        {
          cmd: bin + ' resume' + swarmFlag,
          why: 'Print Mode C relaunch commands (--prompt-file, -r, --fork-session).',
        },
      ],
    },
    {
      id: 'cleanup',
      title: 'Cleanup worktrees',
      items: [
        {
          cmd: bin + ' cleanup --swarm ' + (sid || '<swarm-id>'),
          why: 'Kill PIDs + remove this swarm’s worktrees/branches.',
        },
        {
          cmd: bin + ' mega cleanup --id <mega-id> --full --repo ' + qRepo,
          why: 'Full mega teardown + optional grok worktree gc (GROK_SWARM_WORKTREE_GC=0 to skip).',
        },
        {
          cmd: 'grok du --json\ngrok worktree list --json\ngrok worktree gc --max-age 7d --dry-run',
          why: 'Disk of ~/.grok; list tracked worktrees; dry-run GC (--max-age required or gc expires nothing).',
        },
        {
          cmd: bin + ' mega doctor --expect-clean --repo ' + qRepo,
          why: 'Hard clean check after mission (leftover worktrees fail).',
        },
      ],
    },
    {
      id: 'env',
      title: 'Useful env (workers / dispatch-grok.sh)',
      items: [
        {
          cmd: 'export GROK_SWARM_WORKER_MAX_TURNS=100   # default worker --max-turns\nexport GROK_SWARM_SANDBOX=workspace      # read-only scouts; workspace builders\nexport GROK_SWARM_WORKER_JSON_SCHEMA_MODE=replace  # json + worker-done.schema\nexport GROK_SWARM_DISABLE_WEB_SEARCH=1   # builders only\nexport GROK_SWARM_FORK_ON_FIX=1          # resume --fork-session\nexport GROK_SWARM_WORKTREE_GC=1          # mega cleanup runs grok worktree gc --max-age\nexport GROK_SWARM_WORKTREE_GC_MAX_AGE=7d # required or gc expires nothing',
          why: 'Optional flags applied by dispatch-grok.sh / mega cleanup. Never pass --check or --best-of-n. Model: bin/model-pin.env.',
        },
      ],
    },
  ];

  return {
    repoRoot: repo,
    swarmId: swarmId || 'default',
    workspace: workspace || null,
    registryRoot: registryRoot || null,
    skillBin: bin,
    sections,
    roleMatrix: [
      { role: 'scout / review / logger', flags: '--max-turns · --no-subagents · --disallowed-tools search_replace · sandbox read-only' },
      { role: 'visual', flags: '--max-turns · --no-subagents · --disallowed-tools search_replace · sandbox workspace' },
      { role: 'builder / fix', flags: '--max-turns · --no-subagents · optional sandbox workspace / schema replace / disable-web' },
      { role: 'coordinator', flags: '--max-turns 500 · no --no-subagents · no write denylist' },
    ],
  };
}

module.exports = { buildOperatorGuide, shellSingleQuote };
