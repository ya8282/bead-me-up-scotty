import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AiError, CLAUDE_BIN, isClaudeAvailable, runClaudeCli } from "./ai";
import { getProject } from "./config";
import {
  MAX_GOAL_BEADS,
  type GoalFeedItem,
  type GoalFeedResponse,
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

/**
 * The tail of `claude logs`, made readable: the terminal draws spaces as cursor
 * moves and rows as cursor jumps, so those become spaces and newlines before the
 * remaining escapes are stripped. Short lines are spinner fragments.
 * ponytail: a heuristic over a redrawn screen, so some words still run together
 * where only part of a line was repainted. Good enough to read a question by.
 */
export function cleanScreen(raw: string, maxLines = 30): string {
  const s = raw
    .replace(/\r\n?/g, "\n")
    .replace(/\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)/g, "") // OSC
    .replace(/\x1b\[(\d*)C/g, (_m, n: string) => " ".repeat(Number(n) || 1)) // cursor forward
    .replace(/\x1b\[\d*(?:;\d*)?[BEHf]/g, "\n") // row moves
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // any other CSI
    .replace(/\x1b[@-_]/g, "");
  const lines = s
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length >= 6);
  const tail = lines.slice(-maxLines);
  // The prompt area, a question included, sits at the bottom between horizontal
  // rules; everything above the first rule is spinner and status redraws.
  const rule = tail.findIndex((l) => /─{10,}/.test(l));
  return (rule > 0 ? tail.slice(rule) : tail)
    .join("\n")
    .replace(/─{40,}/g, "─".repeat(40)); // full-width rules wrap in a narrower pane
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
  if (run.state === "blocked") {
    try {
      screen = cleanScreen(await goalLogs(id));
    } catch {
      screen = null;
    }
  }
  return { run, items: items.slice(-FEED_LIMIT), screen };
}
