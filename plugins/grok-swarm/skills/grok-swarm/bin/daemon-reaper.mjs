/**
 * Test-fixture daemon reaper.
 *
 * Swarm commands start real detached daemons (dashboard, healer, coordinator,
 * mega). A test fixture that only `rm -rf`s its temp repo deletes the pidfiles
 * and orphans the processes — on 2026-07-18 eight leaked dashboards were found
 * squatting port 4599, all pointing at long-deleted /tmp fixtures.
 *
 * Every test file that runs a swarm command must call this from a top-level
 * `after()` BEFORE removing the fixture directory. It walks the whole registry
 * so new pidfiles are covered without touching this function again.
 */
import fs from "node:fs";
import path from "node:path";

/** SIGKILL every process referenced by a *.pid file under <repoDir>/.<slug>-swarm/. */
export function reapFixtureDaemons(repoDir, registryDirName = ".grok-swarm") {
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // fixture already gone
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (entry.name.endsWith(".pid")) {
        try {
          process.kill(readPid(p), "SIGKILL");
        } catch {
          /* already dead, unreadable, or not a pid */
        }
      }
    }
  };
  walk(path.join(repoDir, registryDirName));
}

function readPid(file) {
  const raw = fs.readFileSync(file, "utf8").trim();
  const bare = Number(raw);
  if (bare) return bare;
  return JSON.parse(raw).pid;
}
