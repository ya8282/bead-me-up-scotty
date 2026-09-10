"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/components/error-toast";
import { api, type GoalAnswer } from "@/lib/api-client";
import { useApp } from "@/components/app-context";
import { beadsKey } from "./use-beads";

export const goalKey = (projectId: string) => ["goal", projectId] as const;

/**
 * Goal runs for the current project. Polled rather than streamed: the state
 * lives in the Claude CLI, not in beads, so the SSE bead stream never carries it.
 */
export function useGoalRuns(projectId: string, enabled = true) {
  return useQuery({
    queryKey: goalKey(projectId),
    queryFn: () => api.goal.list(projectId),
    enabled,
    refetchInterval: (q) => (q.state.data?.active ? 5000 : 20000),
    // A project with no folder on disk (the demo) cannot host a run; a missing
    // Claude CLI is equally permanent. Retrying either just fills the console.
    retry: false,
  });
}

/**
 * One run's feed. Polls while the run is live, since transcripts are files the
 * CLI appends to and nothing pushes their changes; a finished run loads once.
 */
export function useGoalFeed(projectId: string, runId: string | null, live: boolean) {
  return useQuery({
    queryKey: [...goalKey(projectId), "feed", runId] as const,
    queryFn: () => api.goal.feed(projectId, runId as string),
    enabled: !!runId,
    refetchInterval: live ? 3000 : false,
    retry: false,
  });
}

/** Answer the question a waiting run is showing. */
export function useAnswerGoal() {
  const { projectId } = useApp();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ runId, answer }: { runId: string; answer: GoalAnswer }) =>
      api.goal.answer(projectId, runId, answer),
    onSuccess: (_res, { runId }) => {
      toast.success(`Answered goal run ${runId}`);
      qc.invalidateQueries({ queryKey: goalKey(projectId) });
      // The session takes a moment to repaint its next step; read it again then.
      setTimeout(() => qc.invalidateQueries({ queryKey: goalKey(projectId) }), 2000);
    },
    onError: (err) => toastError(err),
  });
}

/** Start one `/goal` run over the given beads. */
export function useStartGoal() {
  const { projectId } = useApp();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api.goal.start(projectId, ids),
    onSuccess: (res) => {
      toast.success(
        `Goal run ${res.run.id} started on ${res.ids.length} bead${res.ids.length === 1 ? "" : "s"}`,
        { description: `claude attach ${res.run.id}` },
      );
      qc.invalidateQueries({ queryKey: goalKey(projectId) });
      // The run claims beads as it reaches them, so the board is already stale.
      qc.invalidateQueries({ queryKey: beadsKey(projectId) });
    },
    onError: (err) => toastError(err),
  });
}
