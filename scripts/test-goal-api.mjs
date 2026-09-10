#!/usr/bin/env node
/**
 * Runnable check for the goal-run API: `node scripts/test-goal-api.mjs`
 *
 * Boots `next dev` against a throwaway XDG_CONFIG_HOME (so the real project
 * list is untouched) with CLAUDE_BIN and BD_BIN pointed at stubs, then asserts
 * the paths that must never launch an agent, plus the one that must.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-goal-api-"));
const stateFile = path.join(tmp, "sessions.json");
const stub = path.join(tmp, "claude");

fs.writeFileSync(stateFile, "[]");

// The run's transcripts, where Claude Code keeps them: its own under some
// project folder, and one per subagent beside it. Only what a person watching
// needs should come out; tool results and meta entries must not.
const SESSION_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const claudeHome = path.join(tmp, "claude-home");
const sessionDir = path.join(claudeHome, "projects", "-somewhere-else-entirely");
fs.mkdirSync(path.join(sessionDir, SESSION_ID, "subagents"), { recursive: true });
const line = (o) => JSON.stringify(o);
const t = (s) => `2026-09-10T18:00:${String(s).padStart(2, "0")}.000Z`;
fs.writeFileSync(path.join(sessionDir, `${SESSION_ID}.jsonl`), [
  line({ type: "queue-operation", operation: "enqueue" }),
  line({ type: "user", uuid: "u1", timestamp: t(1), message: { content: "<command-message>goal</command-message>\n<command-name>/goal</command-name>\n<command-args>bead-me-up fx-open</command-args>" } }),
  line({ type: "user", uuid: "u2", timestamp: t(2), isMeta: true, message: { content: "Caveat: meta" } }),
  line({ type: "assistant", uuid: "a1", timestamp: t(3), message: { content: [{ type: "text", text: "Planning the set." }, { type: "tool_use", name: "Bash", input: { command: "bd ready" } }] } }),
  line({ type: "user", uuid: "u3", timestamp: t(4), message: { content: [{ type: "tool_result", content: "SECRET TOOL OUTPUT" }] } }),
  line({ type: "assistant", uuid: "a2", timestamp: t(9), message: { content: [{ type: "text", text: "Waiting on review." }] } }),
].join("\n") + "\n");
const subDir = path.join(sessionDir, SESSION_ID, "subagents");
fs.writeFileSync(path.join(subDir, "agent-x1.meta.json"), line({ agentType: "implementer", description: "fx-open work" }));
fs.writeFileSync(path.join(subDir, "agent-x1.jsonl"), [
  line({ type: "user", uuid: "s1", timestamp: t(5), isSidechain: true, message: { content: "Implement fx-open." } }),
  line({ type: "assistant", uuid: "s2", timestamp: t(6), isSidechain: true, message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/repo/a.ts" } }] } }),
].join("\n") + "\n");

fs.writeFileSync(
  stub,
  `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const STATE = ${JSON.stringify(stateFile)};
const read = () => JSON.parse(fs.readFileSync(STATE, "utf8"));

if (args[0] === "--version") { console.log("stub 1.0.0"); process.exit(0); }
if (args[0] === "agents") {
  fs.writeFileSync(STATE + ".cwd", args[args.indexOf("--cwd") + 1] || "");
  console.log(JSON.stringify(read()));
  process.exit(0);
}
if (args[0] === "logs") {
  // A redrawn terminal: spaces as cursor-forward, rows as cursor jumps.
  process.stdout.write("\\x1b[2J\\x1b[1;1H✻ thinking with high effort\\x1b[2;1H──────────────────────\\x1b[3;1HWhich\\x1b[1Cfix\\x1b[1Cshould\\x1b[1Cwe\\x1b[1Cuse?\\x1b[4;1H❯ 1. Close the sheet\\x1b[5;1H  2. Raise the scrim\\x1b[6;1Hab\\n");
  process.exit(0);
}
if (args[0] === "--bg") {
  const id = "ab12cd34";
  const sessions = read();
  sessions.push({ id, cwd: process.cwd(), kind: "background", state: "blocked",
                  startedAt: Date.now(), name: args[1], sessionId: ${JSON.stringify(SESSION_ID)} });
  fs.writeFileSync(STATE, JSON.stringify(sessions));
  console.log("Started background session " + id);
  process.exit(0);
}
process.exit(1);
`,
);
fs.chmodSync(stub, 0o755);

// A fixed tracker, so the check never reads or writes real beads and does not
// depend on what happens to be open in this repo today.
const child = (id, status) => ({ id, title: id, status, issue_type: "task", priority: 1,
  dependencies: [{ issue_id: id, depends_on_id: "fx-epic", type: "parent-child" }] });
const FIXTURE = [
  { id: "fx-epic", title: "fx-epic", status: "open", issue_type: "epic", priority: 1 },
  child("fx-open", "open"),
  child("fx-closed", "closed"),
];
const bdStub = path.join(tmp, "bd");
fs.writeFileSync(
  bdStub,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("bd stub 1.0.0"); process.exit(0); }
if (args[0] === "export") { console.log(${JSON.stringify(FIXTURE.map((b) => JSON.stringify(b)).join("\n"))}); process.exit(0); }
process.exit(1);
`,
);
fs.chmodSync(bdStub, 0o755);

const server = spawn("npx", ["next", "dev", "-p", String(PORT)], {
  cwd: REPO,
  env: {
    ...process.env,
    XDG_CONFIG_HOME: tmp,
    CLAUDE_CONFIG_DIR: claudeHome,
    CLAUDE_BIN: stub,
    BD_BIN: bdStub,
    BROWSER: "none",
  },
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
  assert.equal(beads.status, 200, `list beads: ${JSON.stringify(beads.body)}`);
  assert.equal((beads.body.beads ?? beads.body).length, FIXTURE.length, "reads the stub tracker");
  const epic = { id: "fx-epic" };
  const task = { id: "fx-open" };

  // Closed work is not work.
  const closed = await json("POST", `/api/p/${pid}/goal`, { ids: ["fx-closed"] });
  assert.equal(closed.status, 400, "closed bead must be refused");

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

  // /goal takes [project-name] [bead-id ...]: without the name, the first id
  // would be read as the project and dropped from the set. The lock scans the
  // project folder, since a run may start one level above a nested repo/.
  const projectsRoot = path.join(os.homedir(), "Documents", "Projects");
  const rel = path.relative(projectsRoot, PROJECT);
  const name = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep)[0] : null;
  const prompt = JSON.parse(fs.readFileSync(stateFile, "utf8"))[0].name;
  assert.equal(prompt, ["/goal", ...(name ? [name] : []), task.id].join(" "), "prompt names the project first");
  assert.equal(fs.readFileSync(stateFile + ".cwd", "utf8"),
    name ? path.join(projectsRoot, name) : PROJECT, "lock scans the whole project folder");

  // 6. The lock: one writer per working tree.
  const second = await json("POST", `/api/p/${pid}/goal`, { ids: [task.id] });
  assert.equal(second.status, 409, "a second run must be refused while one is live");
  assert.match(second.body.error, /ab12cd34/, "refusal should name the active run");

  // 7. "blocked" is still live — it is waiting on a permission prompt.
  const busy = await json("GET", `/api/p/${pid}/goal`);
  assert.equal(busy.body.active.state, "blocked", "blocked run stays active");

  // 8. The feed: the run's own transcript and its subagent's, in time order,
  //    wherever Claude Code filed them, without tool results or meta entries.
  const feed = await json("GET", `/api/p/${pid}/goal/ab12cd34`);
  assert.equal(feed.status, 200, `feed: ${JSON.stringify(feed.body)}`);
  assert.deepEqual(
    feed.body.items.map((i) => [i.source, i.kind, i.text]),
    [
      ["main", "command", "/goal bead-me-up fx-open"],
      ["main", "text", "Planning the set."],
      ["main", "tool", "Bash: bd ready"],
      ["implementer: fx-open work", "prompt", "Implement fx-open."],
      ["implementer: fx-open work", "tool", "Edit: /repo/a.ts"],
      ["main", "text", "Waiting on review."],
    ],
    "merged feed in time order",
  );
  assert.ok(!JSON.stringify(feed.body).includes("SECRET TOOL OUTPUT"), "tool results stay out of the feed");
  // Blocked: the pending question lives only on screen, so the screen comes too.
  assert.match(feed.body.screen, /Which fix should we use\?/, "cursor moves become spaces");
  assert.match(feed.body.screen, /2\. Raise the scrim/, "each row on its own line");
  assert.doesNotMatch(feed.body.screen, /^ab$/m, "spinner fragments are dropped");
  assert.doesNotMatch(feed.body.screen, /thinking with high effort/, "status redraws above the prompt rule are dropped");
  assert.match(feed.body.screen, /^─{10,}/, "the screen starts at the prompt area");

  // Only this project's runs are readable, and ids never become paths.
  const stranger = await json("GET", `/api/p/${pid}/goal/ffffffff`);
  assert.equal(stranger.status, 404, "a run this project does not list is refused");
  const traversal = await json("GET", `/api/p/${pid}/goal/..%2F..%2Fetc`);
  assert.equal(traversal.status, 400, "a non-id is refused before any lookup");

  // 9. Only "done" releases the lock.
  const done = JSON.parse(fs.readFileSync(stateFile, "utf8")).map((s) => ({ ...s, state: "done" }));
  fs.writeFileSync(stateFile, JSON.stringify(done));
  const free = await json("GET", `/api/p/${pid}/goal`);
  assert.equal(free.body.active, null, "a done run releases the lock");
  assert.equal(free.body.runs.length, 1, "the finished run is still listed");
  const finished = await json("GET", `/api/p/${pid}/goal/ab12cd34`);
  assert.equal(finished.body.screen, null, "no screen once nothing is waiting");
  assert.equal(finished.body.items.length, 6, "a finished run's feed stays readable");

  console.log("test-goal-api: all checks passed");
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
