#!/usr/bin/env node
/**
 * Runnable check for the goal-run API: `node scripts/goal-api-check.mjs`
 *
 * Boots `next dev` against a throwaway XDG_CONFIG_HOME (so the real project
 * list is untouched) with CLAUDE_BIN pointed at a stub, then asserts the paths
 * that must never launch an agent, plus the one that must.
 *
 * The stub records a session on `--bg`, so the 409 in step 6 is produced by the
 * same lock the real CLI would drive, and no actual /goal run is ever started.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const REPO = process.cwd();

/** The project a goal run works in: the nearest ancestor holding .beads. */
function beadsRoot(from) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".beads"))) return dir;
    if (dir === path.dirname(dir)) throw new Error("no .beads directory above " + from);
  }
}
const PROJECT = beadsRoot(REPO);
const PORT = 34567;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goal-api-check-"));
const stateFile = path.join(tmp, "sessions.json");
const stub = path.join(tmp, "claude");

fs.writeFileSync(stateFile, "[]");
fs.writeFileSync(
  stub,
  `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const STATE = ${JSON.stringify(stateFile)};
const read = () => JSON.parse(fs.readFileSync(STATE, "utf8"));

if (args[0] === "--version") { console.log("stub 1.0.0"); process.exit(0); }
if (args[0] === "agents") { console.log(JSON.stringify(read())); process.exit(0); }
if (args[0] === "--bg") {
  const id = "ab12cd34";
  const sessions = read();
  sessions.push({ id, cwd: process.cwd(), kind: "background", state: "blocked",
                  startedAt: Date.now(), name: args[1] });
  fs.writeFileSync(STATE, JSON.stringify(sessions));
  console.log("Started background session " + id);
  process.exit(0);
}
process.exit(1);
`,
);
fs.chmodSync(stub, 0o755);

const server = spawn("npx", ["next", "dev", "-p", String(PORT)], {
  cwd: REPO,
  env: { ...process.env, XDG_CONFIG_HOME: tmp, CLAUDE_BIN: stub, BROWSER: "none" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

const json = async (method, url, body) => {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${BASE}/api/projects`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`dev server did not start:\n${serverLog}`);
}

let failure;
try {
  await waitForServer();

  const added = await json("POST", "/api/projects", { path: PROJECT });
  assert.equal(added.status, 201, `add project: ${JSON.stringify(added.body)}`);
  const pid = added.body.id;

  const beads = await json("GET", `/api/p/${pid}/beads`);
  assert.equal(beads.status, 200, "list beads");
  const all = beads.body.beads ?? beads.body;
  const epic = all.find((b) => b.issue_type === "epic");
  const task = all.find((b) => b.issue_type !== "epic" && b.status !== "closed");
  assert.ok(epic && task, "fixture needs one epic and one open non-epic bead");

  // 1. No run yet.
  const idle = await json("GET", `/api/p/${pid}/goal`);
  assert.equal(idle.status, 200, "GET goal");
  assert.equal(idle.body.active, null, "no run should be active yet");

  // 2. Unknown ids never reach the prompt.
  const unknown = await json("POST", `/api/p/${pid}/goal`, { ids: ["nope-999"] });
  assert.equal(unknown.status, 400, "unknown id must be refused");

  // 3. An epic is a container, not work.
  const asEpic = await json("POST", `/api/p/${pid}/goal`, { ids: [epic.id] });
  assert.equal(asEpic.status, 400, "epic id must be refused");
  assert.match(asEpic.body.error, /children/, "error should point at the children");

  // 4. Over the cap /goal itself honours.
  const tooMany = await json("POST", `/api/p/${pid}/goal`, {
    ids: Array.from({ length: 21 }, (_, i) => `x-${i}`),
  });
  assert.equal(tooMany.status, 400, "more than 20 beads must be refused");

  // 5. A valid set starts exactly one run.
  const started = await json("POST", `/api/p/${pid}/goal`, { ids: [task.id] });
  assert.equal(started.status, 202, `start run: ${JSON.stringify(started.body)}`);
  assert.equal(started.body.run.id, "ab12cd34", "should return the session id");
  assert.equal(started.body.run.live, true, "a fresh run is live");

  // 6. The lock: one writer per working tree.
  const second = await json("POST", `/api/p/${pid}/goal`, { ids: [task.id] });
  assert.equal(second.status, 409, "a second run must be refused while one is live");
  assert.match(second.body.error, /ab12cd34/, "refusal should name the active run");

  // 7. "blocked" is still live — it is waiting on a permission prompt.
  const busy = await json("GET", `/api/p/${pid}/goal`);
  assert.equal(busy.body.active.state, "blocked", "blocked run stays active");

  // 8. Only "done" releases the lock.
  const done = JSON.parse(fs.readFileSync(stateFile, "utf8")).map((s) => ({ ...s, state: "done" }));
  fs.writeFileSync(stateFile, JSON.stringify(done));
  const free = await json("GET", `/api/p/${pid}/goal`);
  assert.equal(free.body.active, null, "a done run releases the lock");
  assert.equal(free.body.runs.length, 1, "the finished run is still listed");

  console.log("goal-api-check: 8/8 passed");
} catch (e) {
  failure = e;
} finally {
  server.kill("SIGTERM");
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (failure) {
  console.error(failure.message);
  process.exit(1);
}
