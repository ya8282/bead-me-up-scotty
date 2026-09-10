import "server-only";
import os from "node:os";
import path from "node:path";
import { AiError, CLAUDE_BIN, isClaudeAvailable, runClaudeCli } from "./ai";
import { MAX_GOAL_BEADS, type GoalRun } from "./api-client";

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
