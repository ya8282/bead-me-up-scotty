import { z } from "zod";
import { getStore } from "@/lib/store";
import { ok, fail } from "@/lib/api";
import { AiError } from "@/lib/ai";
import { goalRepoPath as repoPathOf, listGoals, startGoal, MAX_GOAL_BEADS } from "@/lib/goal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string }> };

const bodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(MAX_GOAL_BEADS),
});

/** Goal runs for this project, plus the one holding the working tree. */
export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { projectId } = await params;
    const runs = await listGoals(repoPathOf(projectId));
    return ok({ runs, active: runs.find((r) => r.live) ?? null });
  } catch (e) {
    return fail(e);
  }
}

/** Queue one `/goal` run over the given beads. */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { projectId } = await params;
    const repoPath = repoPathOf(projectId);
    const { ids } = bodySchema.parse(await req.json());

    // Validate against the real store rather than trusting client ids: they end
    // up in a prompt that an autonomous agent then acts on.
    const store = await getStore(projectId);
    const byId = new Map((await store.list()).map((b) => [b.id, b]));

    const unknown = ids.filter((id) => !byId.has(id));
    if (unknown.length) {
      throw new AiError(`No such bead in this project: ${unknown.join(", ")}.`, "invalid_input");
    }
    const closed = ids.filter((id) => byId.get(id)?.status === "closed");
    if (closed.length) {
      throw new AiError(
        `Already closed, so there is nothing to work: ${closed.join(", ")}. Deselect them and try again.`,
        "invalid_input",
      );
    }
    // An epic is a container. /goal hands each id straight to an implementer, so
    // an epic id would have the agent try to build the epic instead of its children.
    const epics = ids.filter((id) => byId.get(id)?.issue_type === "epic");
    if (epics.length) {
      throw new AiError(
        `Send an epic's children rather than the epic itself: ${epics.join(", ")}.`,
        "invalid_input",
      );
    }

    const run = await startGoal(repoPath, ids);
    return ok({ run, ids }, 202);
  } catch (e) {
    return fail(e);
  }
}
