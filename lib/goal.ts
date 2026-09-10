import "server-only";
import { AiError, CLAUDE_BIN, isClaudeAvailable, runClaudeCli } from "./ai";

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

/** A `/goal` background session as `claude agents --json` reports it. */
export interface GoalRun {
  id: string;
  cwd: string;
  /** Observed: "done" once finished, "blocked" while waiting on a permission prompt. */
  state: string;
  startedAt: number;
  sessionId?: string;
  name?: string;
  live: boolean;
}

/**
 * States that release the lock. Only "done" is confirmed terminal, so anything
 * unrecognised counts as LIVE on purpose: a stuck lock is an annoyance, while
 * releasing it early drops a second agent into a tree the first is mid-write on.
 * ponytail: widen this set as new terminal states are observed, never by guessing.
 */
const TERMINAL_STATES = new Set(["done"]);

/** /goal stops itself after 20 closed beads, so a larger set cannot be honoured. */
export const MAX_GOAL_BEADS = 20;

function parseAgents(stdout: string): unknown[] {
  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new AiError("Could not parse the output of `claude agents --json`.", "bad_output");
  }
}

/** Every background session for this repo, newest first. */
export async function listGoals(repoPath: string): Promise<GoalRun[]> {
  const stdout = await runClaudeCli(["agents", "--json", "--all", "--cwd", repoPath], 20_000);
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
        `It owns the working tree until it finishes, so only one run can go at a time.`,
      "goal_run_active",
    );
  }

  const stdout = await runClaudeCli(["--bg", `/goal ${ids.join(" ")}`], 60_000, repoPath);
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
