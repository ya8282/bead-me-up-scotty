import { ok, fail } from "@/lib/api";
import { goalFeed, goalRepoPath } from "@/lib/goal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string; runId: string }> };

/** A run's feed: its transcripts merged in time order, plus its screen while blocked. */
export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { projectId, runId } = await params;
    return ok(await goalFeed(goalRepoPath(projectId), runId));
  } catch (e) {
    return fail(e);
  }
}
