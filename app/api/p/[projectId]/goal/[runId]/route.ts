import { z } from "zod";
import { ok, fail } from "@/lib/api";
import { answerGoal, goalFeed, goalRepoPath } from "@/lib/goal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string; runId: string }> };

/** A run's feed: its transcripts merged in time order, plus its question while blocked. */
export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { projectId, runId } = await params;
    return ok(await goalFeed(goalRepoPath(projectId), runId));
  } catch (e) {
    return fail(e);
  }
}

const answerSchema = z.object({
  key: z.string().regex(/^[0-9a-f]{16}$/),
  // A multi-select sends its whole set; empty means "none of these".
  options: z.array(z.number().int().min(1).max(99)).max(32),
  text: z.string().max(2000).optional(),
});

/** Answer the question a waiting run is showing. Read Only Mode refuses this in proxy.ts. */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { projectId, runId } = await params;
    await answerGoal(goalRepoPath(projectId), runId, answerSchema.parse(await req.json()));
    return ok({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
