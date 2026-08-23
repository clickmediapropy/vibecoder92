/**
 * swarm learnings — list / resolve paths for Logger agent output.
 * Zero third-party deps.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function preferredLearningsRoot(repo) {
  const solutions = path.join(repo, 'docs', 'solutions');
  if (fs.existsSync(solutions) && fs.statSync(solutions).isDirectory()) {
    return { root: solutions, index: path.join(solutions, 'INDEX.md'), style: 'docs/solutions' };
  }
  const learnings = path.join(repo, 'docs', 'learnings');
  if (fs.existsSync(learnings) && fs.statSync(learnings).isDirectory()) {
    const swarmDir = path.join(learnings, 'swarm');
    return {
      root: swarmDir,
      index: path.join(learnings, 'INDEX.md'),
      style: 'docs/learnings',
    };
  }
  const local = path.join(repo, '.grok-swarm', 'learnings');
  return {
    root: local,
    index: path.join(local, 'INDEX.md'),
    style: '.grok-swarm/learnings',
  };
}

function walkMd(dir, out, depth) {
  if (depth > 6 || !fs.existsSync(dir)) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      walkMd(p, out, depth + 1);
    } else if (ent.isFile() && ent.name.endsWith('.md') && ent.name !== 'INDEX.md') {
      let mtime = 0;
      try {
        mtime = fs.statSync(p).mtimeMs;
      } catch {
        /* ignore */
      }
      out.push({ path: p, name: ent.name, mtime });
    }
  }
}

function learningsCommand(ctx, argv) {
  const args = ctx.parseArgs(argv);
  const repo =
    (args.repo && args.repo !== 'true' ? path.resolve(args.repo) : null) ||
    (args.cwd && args.cwd !== 'true' ? path.resolve(args.cwd) : null) ||
    process.cwd();
  const sub = args._[0] || 'list';

  if (sub === 'path') {
    const pref = preferredLearningsRoot(repo);
    if (args.json === 'true') {
      console.log(JSON.stringify({ repo, ...pref }, null, 2));
    } else {
      console.log('LEARNINGS_ROOT style=' + pref.style);
      console.log('  root:  ' + pref.root);
      console.log('  index: ' + pref.index);
      console.log('  swarm: ' + path.join(repo, '.grok-swarm', 'learnings', 'by-swarm'));
      console.log('  mega:  ' + path.join(repo, '.grok-swarm', 'learnings', 'by-mega'));
    }
    return;
  }

  // list
  const pref = preferredLearningsRoot(repo);
  const files = [];
  walkMd(pref.root, files, 0);
  walkMd(path.join(repo, '.grok-swarm', 'learnings'), files, 0);

  const swarmFilter = args.swarm && args.swarm !== 'true' ? args.swarm : null;
  const megaFilter = args.mega && args.mega !== 'true' ? args.mega : null;
  let filtered = files;
  if (swarmFilter) {
    filtered = filtered.filter(
      (f) => f.path.includes(path.join('by-swarm', swarmFilter)) || f.path.includes(swarmFilter),
    );
  }
  if (megaFilter) {
    filtered = filtered.filter(
      (f) => f.path.includes(path.join('by-mega', megaFilter)) || f.path.includes(megaFilter),
    );
  }
  // dedupe by path
  const seen = new Set();
  filtered = filtered.filter((f) => {
    if (seen.has(f.path)) return false;
    seen.add(f.path);
    return true;
  });
  filtered.sort((a, b) => b.mtime - a.mtime);

  if (args.json === 'true') {
    console.log(
      JSON.stringify(
        {
          repo,
          preferred: pref,
          count: filtered.length,
          files: filtered.map((f) => ({
            path: f.path,
            name: f.name,
            mtime: f.mtime,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log('Learnings — ' + repo + ' (style=' + pref.style + ')');
  console.log('  preferred root: ' + pref.root);
  if (!filtered.length) {
    console.log('  (none yet — Logger runs after merge; see templates/logger-prompt.md)');
    return;
  }
  for (const f of filtered.slice(0, 50)) {
    const rel = path.relative(repo, f.path);
    console.log('  - ' + rel);
  }
  if (filtered.length > 50) console.log('  … +' + (filtered.length - 50) + ' more');
}

module.exports = {
  preferredLearningsRoot,
  learningsCommand,
};
