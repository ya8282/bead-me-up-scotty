import "server-only";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Terminal } from "@xterm/headless";
import { AiError, CLAUDE_BIN, childEnv, isClaudeAvailable, runClaudeCli } from "./ai";
import { getProject } from "./config";
import {
  MAX_GOAL_BEADS,
  type GoalFeedItem,
  type GoalFeedResponse,
  type GoalPrompt,
  type GoalRun,
} from "./api-client";

/**
 * The folder a goal run works in. The demo project has no path, and a run that
 * cannot check out a branch or commit has nothing to do.
 */
export function goalRepoPath(projectId: string): string {
  const project = getProject(projectId);
  if (!project?.path) {
    throw new AiError(
      "Goal runs need a project folder on disk. Add this project from a local repo, then try again.",
      "no_repo_path",
    );
  }
  return project.path;
}

/**
 * Launch and inspect Claude Code `/goal` runs as background sessions.
 *
 * `claude --bg` is the whole job queue: it starts a detached session, prints its
 * short id, and `claude agents --json` reports the state of every session
 * afterwards. So there is no job table here and nothing to supervise.
 *
 * The one invariant this module owns is that at most ONE run is live per repo.
 * `--bg` does NOT create a git worktree (that is the separate `--worktree`
 * flag), so two concurrent runs would be two writers in one working tree, each
 * committing and pushing over the other. startGoal() refuses while a run is
 * live; the caller surfaces that rather than queueing behind it.
 */

export { MAX_GOAL_BEADS };
export type { GoalRun };

/**
 * States that release the lock. Only "done" is confirmed terminal, so anything
 * unrecognised counts as LIVE on purpose: a stuck lock is an annoyance, while
 * releasing it early drops a second agent into a tree the first is mid-write on.
 * ponytail: widen this set as new terminal states are observed, never by guessing.
 */
const TERMINAL_STATES = new Set(["done"]);

const PROJECTS_ROOT = path.join(os.homedir(), "Documents", "Projects");

/**
 * The project `/goal` works in. `/goal [project-name] [bead-id ...]` resolves
 * ~/Documents/Projects/<name> and then prefers a nested repo/, so the name is
 * what it expects first; sent without it, the first bead id would be read as
 * the project and dropped from the set.
 *
 * `root` is where a run can start from: the project folder, which may sit one
 * level above the repo (…/oculist while the repo is …/oculist/repo). The lock
 * scans that whole folder, or a run started from the parent would go unseen.
 * ponytail: outside ~/Documents/Projects there is no name to send and the root
 * is the repo itself; widen this if /goal learns other layouts.
 */
export function goalProject(repoPath: string): { name: string | null; root: string } {
  const rel = path.relative(PROJECTS_ROOT, repoPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return { name: null, root: repoPath };
  const name = rel.split(path.sep)[0];
  return { name, root: path.join(PROJECTS_ROOT, name) };
}

function parseAgents(stdout: string): unknown[] {
  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new AiError("Could not parse the output of `claude agents --json`.", "bad_output");
  }
}

/** Every background session started anywhere in this repo's project folder, newest first. */
export async function listGoals(repoPath: string): Promise<GoalRun[]> {
  const { root } = goalProject(repoPath);
  const stdout = await runClaudeCli(["agents", "--json", "--all", "--cwd", root], 20_000);
  return parseAgents(stdout)
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .filter((s) => s.kind === "background" && typeof s.id === "string")
    .map((s) => {
      const state = typeof s.state === "string" ? s.state : "unknown";
      return {
        id: s.id as string,
        cwd: typeof s.cwd === "string" ? s.cwd : repoPath,
        state,
        startedAt: typeof s.startedAt === "number" ? s.startedAt : 0,
        sessionId: typeof s.sessionId === "string" ? s.sessionId : undefined,
        name: typeof s.name === "string" ? s.name : undefined,
        live: !TERMINAL_STATES.has(state),
      };
    })
    .sort((a, b) => b.startedAt - a.startedAt);
}

/** The run currently holding this repo's working tree, if any. */
export async function activeGoal(repoPath: string): Promise<GoalRun | null> {
  return (await listGoals(repoPath)).find((r) => r.live) ?? null;
}

/**
 * Start `/goal <ids>` as one background session working the whole set. One
 * session per set, never one per bead: /goal opens a single branch, commits per
 * bead and pushes once, so N sessions would be N branches racing in one tree.
 */
export async function startGoal(repoPath: string, ids: string[]): Promise<GoalRun> {
  if (ids.length === 0) throw new AiError("No beads were selected.", "empty_goal_set");
  if (ids.length > MAX_GOAL_BEADS) {
    throw new AiError(
      `A goal run takes at most ${MAX_GOAL_BEADS} beads, which is where /goal stops itself.`,
      "goal_set_too_large",
    );
  }
  if (!(await isClaudeAvailable())) {
    throw new AiError(
      `The Claude CLI ("${CLAUDE_BIN}") was not found on PATH. Install Claude Code or set CLAUDE_BIN.`,
      "claude_unavailable",
    );
  }

  const live = await activeGoal(repoPath);
  if (live) {
    throw new AiError(
      `Goal run ${live.id} is already active in this project (${live.state}). ` +
        `It owns the working tree until it finishes. Run "claude attach ${live.id}" ` +
        `to take it over, or "claude stop ${live.id}" to end it.`,
      "goal_run_active",
    );
  }

  const { name } = goalProject(repoPath);
  const prompt = ["/goal", ...(name ? [name] : []), ...ids].join(" ");
  const stdout = await runClaudeCli(["--bg", prompt], 60_000, repoPath);
  const id = stdout.match(/\b[0-9a-f]{8}\b/)?.[0];
  if (!id) throw new AiError("Claude did not report a background session id.", "bad_output");

  const started = (await listGoals(repoPath)).find((r) => r.id === id);
  return started ?? { id, cwd: repoPath, state: "unknown", startedAt: Date.now(), live: true };
}

/** Recent terminal output of a run, for a log pane. */
export async function goalLogs(id: string): Promise<string> {
  if (!/^[0-9a-f]{6,40}$/.test(id)) throw new AiError("Not a session id.", "invalid_input");
  return runClaudeCli(["logs", id], 20_000);
}

// ---- run output: the Goals view's feed ----

/** Claude Code's data folder. The CLI honours CLAUDE_CONFIG_DIR, so this does too. */
function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The transcripts a run writes: its own, plus one per subagent it dispatches,
 * which is where most of a /goal run's implementation actually happens.
 *
 * Looked up by session id rather than derived from the run's cwd, because the
 * transcript moves with the session: a run that enters its own worktree
 * relocates to a different project folder mid-run.
 */
function transcriptFiles(sessionId: string): { file: string; source: string }[] {
  if (!SESSION_ID.test(sessionId)) return [];
  const projects = path.join(claudeDir(), "projects");
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return [];
  }
  const main = dirs
    .map((d) => path.join(projects, d, `${sessionId}.jsonl`))
    .filter((f) => fs.existsSync(f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!main) return [];

  const files = [{ file: main, source: "main" }];
  const subDir = path.join(main.slice(0, -".jsonl".length), "subagents");
  let subs: string[] = [];
  try {
    subs = fs.readdirSync(subDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    /* no subagents yet */
  }
  for (const f of subs) {
    let source = "subagent";
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(subDir, f.replace(/\.jsonl$/, ".meta.json")), "utf8"));
      source = [meta.agentType, meta.description].filter(Boolean).join(": ") || source;
    } catch {
      /* unlabelled subagent */
    }
    files.push({ file: path.join(subDir, f), source });
  }
  return files;
}

/**
 * The last TAIL_BYTES of a transcript, as whole lines.
 * ponytail: re-reads the tail on every poll rather than tracking offsets, so
 * only the most recent ~256 KB per transcript is visible; add per-file offsets
 * if people need to scroll a long run's full history in here.
 */
const TAIL_BYTES = 256 * 1024;
function readTail(file: string): string[] {
  const fd = fs.openSync(file, "r");
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // cut mid-record
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

function toolSummary(name: unknown, input: unknown): string {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const detail = ["command", "file_path", "pattern", "description", "url", "prompt"]
    .map((k) => args[k])
    .find((v): v is string => typeof v === "string" && v.trim() !== "");
  const label = typeof name === "string" ? name : "tool";
  return detail ? `${label}: ${detail.trim()}` : label;
}

/**
 * What a person watching would want from a transcript, the same cut goalwatch
 * makes: what the run says, and each tool it runs. Tool results are skipped;
 * they are the bulk of the file and mostly noise at this altitude.
 */
function parseTranscript(lines: string[], source: string): GoalFeedItem[] {
  const items: GoalFeedItem[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const at = typeof e.timestamp === "string" ? e.timestamp : "";
    const id = typeof e.uuid === "string" ? e.uuid : "";
    if (!at || !id || e.isMeta) continue;
    const content = (e.message as { content?: unknown } | undefined)?.content;

    if (e.type === "user") {
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((c) => c?.type === "text" && typeof c.text === "string")
                .map((c) => c.text)
                .join("\n")
            : "";
      if (!text.trim()) continue; // tool results
      const name = text.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1];
      if (name) {
        const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] ?? "";
        items.push({ id, at, source, kind: "command", text: `${name} ${args}`.trim() });
      } else if (!text.trimStart().startsWith("<")) {
        // A person typing into an attached session, or a parent briefing its subagent.
        items.push({ id, at, source, kind: "prompt", text: text.trim() });
      }
      continue;
    }

    if (e.type !== "assistant" || !Array.isArray(content)) continue;
    content.forEach((c, i) => {
      if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) {
        items.push({ id: `${id}:${i}`, at, source, kind: "text", text: c.text.trim() });
      } else if (c?.type === "tool_use") {
        items.push({ id: `${id}:${i}`, at, source, kind: "tool", text: toolSummary(c.name, c.input) });
      }
    });
  }
  return items;
}

// ---- the screen: what a waiting run is asking ----

/**
 * The session's terminal width. Claude Code draws the prompt area between rules
 * that span the full width, so the latest rules give it away. A session nobody
 * has attached to runs at 200 columns.
 */
function screenWidth(raw: string): number {
  const rules = raw.match(/─{20,}/g);
  return rules ? Math.max(...rules.slice(-3).map((r) => r.length)) : 200;
}

/**
 * `claude logs` is a stream of repaints, not a screen: only the characters that
 * changed get redrawn, so reading it as text loses spacing and even option
 * numbers. Replaying it through a real terminal emulator gives back exactly
 * what `claude attach` would show.
 */
async function renderScreen(raw: string): Promise<string[]> {
  const term = new Terminal({ cols: screenWidth(raw), rows: 60, scrollback: 0, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(raw, resolve));
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = buf.baseY; i < buf.baseY + term.rows; i++) {
    lines.push(buf.getLine(i)?.translateToString(true).trimEnd() ?? "");
  }
  term.dispose();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}

const OPTION = /^\s*[❯›>]?\s*(\d{1,2})\.\s+(\S.*?)\s*$/;
const RULE = /^\s*─{10,}\s*$/;
const HINT = /Enter to (select|confirm)|Esc to cancel|Tab\/Arrow keys|ctrl\+g to edit/i;

/**
 * The question a waiting run shows, as data: an AskUserQuestion step (including
 * the review screen before submitting) or a permission prompt. Both are a
 * numbered list at the bottom of the screen, so the list is found by counting
 * down from its last number to 1, and the question is what sits between it and
 * the rule above.
 */
function parsePrompt(lines: string[]): GoalPrompt | null {
  let i = lines.length - 1;
  while (i >= 0 && !OPTION.test(lines[i])) i--;
  if (i < 0) return null;

  const at: { n: number; label: string; line: number }[] = [];
  for (let want = Number(lines[i].match(OPTION)![1]); i >= 0 && want >= 1; i--) {
    const m = lines[i].match(OPTION);
    if (m && Number(m[1]) === want) {
      at.unshift({ n: want, label: m[2], line: i });
      want--;
    }
  }
  if (at[0]?.n !== 1) return null;

  let top = at[0].line - 1;
  while (top >= 0 && !RULE.test(lines[top])) top--;
  const area = lines.slice(top + 1, at[0].line).filter((l) => l.trim());
  const tabs = area.find((l) => /[←→]/.test(l) && /[☐☒✔]/.test(l))?.trim() ?? "";
  const question = area.filter((l) => l.trim() !== tabs).map((l) => l.trim()).join("\n");

  const options = at
    .map(({ n, label, line }, k) => {
      const end = at[k + 1]?.line ?? lines.length;
      const detail = lines
        .slice(line + 1, end)
        .filter((l) => l.trim() && !RULE.test(l) && !HINT.test(l))
        .map((l) => l.trim())
        .join(" ");
      return { n, label, detail, freeText: /^Type something\.?$/i.test(label) };
    })
    // Declining into a free-form chat needs a conversation, not a button.
    .filter((o) => !/^Chat about this/i.test(o.label));

  const shown = lines
    .slice(Math.max(top, 0))
    .map((l) => (RULE.test(l) ? "─".repeat(40) : l))
    .join("\n");
  const key = createHash("sha1")
    .update(JSON.stringify([tabs, question, options.map((o) => o.label)]))
    .digest("hex")
    .slice(0, 16);
  return { key, tabs, question, options, screen: shown };
}

/**
 * Types into a running session through `claude attach` in a pseudo-terminal,
 * the only input path Claude Code offers a background session. It sizes the
 * terminal to the session's own width, waits until the expected text is on
 * screen, sends each chunk, then detaches with Ctrl+Z, which leaves the session
 * running. Python's pty module does the terminal, since Node has none built in.
 */
const PTY_RELAY = `
import fcntl, json, os, pty, re, select, struct, sys, termios, time
session, cols, expect, chunks = sys.argv[1], int(sys.argv[2]), sys.argv[3], json.loads(sys.argv[4])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(os.environ.get("CLAUDE_BIN", "claude"), [os.environ.get("CLAUDE_BIN", "claude"), "attach", session])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 60, cols, 0, 0))
out = b""
def pump(seconds):
    global out
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                out += os.read(fd, 65536)
            except OSError:
                return
def seen():
    text = re.sub(r"\\x1b\\[[0-9;?]*[ -/]*[@-~]", "", out.decode("utf8", "replace"))
    return expect in re.sub(r"\\s+", "", text)
deadline = time.time() + 12
while time.time() < deadline and not seen():
    pump(0.3)
ok = seen()
if ok:
    for chunk in chunks:
        os.write(fd, chunk.encode())
        pump(1.2)
os.write(fd, b"\\x1a")
pump(1)
try:
    os.kill(pid, 9)
except ProcessLookupError:
    pass
sys.exit(0 if ok else 3)
`;

function typeIntoSession(id: string, cols: number, expect: string, chunks: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "python3",
      ["-c", PTY_RELAY, id, String(cols), expect, JSON.stringify(chunks)],
      { timeout: 40_000, env: childEnv() },
      (err) => {
        if (!err) return resolve();
        // A spawn failure carries a string code; a non-zero exit carries the number.
        const e = err as Error & { code?: string | number };
        if (e.code === "ENOENT") {
          return reject(new AiError("Answering from Scotty needs python3 on PATH.", "python_unavailable"));
        }
        if (e.code === 3) {
          return reject(
            new AiError(
              "The question was not on the run's screen when Scotty attached, so nothing was sent. Reload and try again.",
              "prompt_changed",
            ),
          );
        }
        reject(new AiError(`Could not reach goal run ${id}: ${e.message}`, "claude_failed"));
      },
    );
  });
}

/** Printable text only: a control character or newline would press keys the person never chose. */
function typedText(text: unknown): string {
  return typeof text === "string" ? text.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 2000) : "";
}

/**
 * Answer the question a waiting run is showing. The caller names the prompt it
 * was looking at by key, and the screen is re-read first: if the run has moved
 * on, nothing is sent, so a click can never land on a different question.
 */
export async function answerGoal(
  repoPath: string,
  id: string,
  answer: { key: string; option: number; text?: string },
): Promise<void> {
  if (!/^[0-9a-f]{6,40}$/.test(id)) throw new AiError("Not a goal run id.", "invalid_input");
  const run = (await listGoals(repoPath)).find((r) => r.id === id);
  if (!run) throw new AiError(`There is no goal run ${id} in this project.`, "unknown_run");
  if (run.state !== "blocked") {
    throw new AiError(`Goal run ${id} is not waiting on an answer right now (${run.state}).`, "not_waiting");
  }

  const raw = await goalLogs(id);
  const prompt = parsePrompt(await renderScreen(raw));
  if (!prompt || prompt.key !== answer.key) {
    throw new AiError(
      "The run's question changed since this page loaded. Review the new one and answer again.",
      "prompt_changed",
    );
  }
  const option = prompt.options.find((o) => o.n === answer.option);
  if (!option) throw new AiError(`Option ${answer.option} is not one of this question's choices.`, "invalid_input");

  const chunks = [String(option.n)];
  if (option.freeText) {
    const text = typedText(answer.text);
    if (!text) throw new AiError("Type your answer before sending it.", "invalid_input");
    chunks.push(text, "\r");
  }
  // Waiting for the option's own label confirms the attach landed on this prompt.
  await typeIntoSession(id, screenWidth(raw), option.label.replace(/\s+/g, ""), chunks);
}

const FEED_LIMIT = 300;

/**
 * One run's feed, merged across its transcripts in time order. Only runs that
 * `claude agents` lists for this project are readable, so a request can never
 * name a path or another project's session.
 */
export async function goalFeed(repoPath: string, id: string): Promise<GoalFeedResponse> {
  if (!/^[0-9a-f]{6,40}$/.test(id)) throw new AiError("Not a goal run id.", "invalid_input");
  const run = (await listGoals(repoPath)).find((r) => r.id === id);
  if (!run) throw new AiError(`There is no goal run ${id} in this project.`, "unknown_run");

  const items = run.sessionId
    ? transcriptFiles(run.sessionId).flatMap(({ file, source }) => parseTranscript(readTail(file), source))
    : [];
  items.sort((a, b) => a.at.localeCompare(b.at));

  // A pending question is not written to any transcript until it is answered,
  // so the screen is the only place to read it while the run waits.
  let screen: string | null = null;
  let prompt: GoalPrompt | null = null;
  if (run.state === "blocked") {
    try {
      const lines = await renderScreen(await goalLogs(id));
      prompt = parsePrompt(lines);
      screen = prompt?.screen ?? lines.slice(-25).join("\n");
    } catch {
      screen = null;
    }
  }
  return { run, items: items.slice(-FEED_LIMIT), screen, prompt };
}
