"use client";
import * as React from "react";
import { Icon } from "@/components/icons";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useApp } from "@/components/app-context";
import { useGoalRuns, useStartGoal } from "@/hooks/use-goal";
import { MAX_GOAL_BEADS } from "@/lib/api-client";
import { cn } from "@/lib/utils";

/**
 * Hand a set of beads to one Claude Code `/goal` run.
 *
 * Confirmed rather than fired on click: a run branches, commits per bead and
 * pushes, so it deserves more weight than a status change. The dialog shows the
 * exact set, because the run fixes it at the start and never grows it.
 */
export function RunGoalButton({
  ids,
  label = "Run goal",
  className,
}: {
  ids: string[];
  label?: string;
  className?: string;
}) {
  const { projectId, readOnly } = useApp();
  const [open, setOpen] = React.useState(false);
  const { data } = useGoalRuns(projectId, !readOnly);
  const start = useStartGoal();

  const active = data?.active ?? null;
  // Busy is refused server-side (toastError surfaces it); idle is only a warning,
  // since nothing is being written right now.
  const idleSession = (data?.interactive ?? []).find((s) => s.status === "idle");
  const tooMany = ids.length > MAX_GOAL_BEADS;
  const disabled = readOnly || ids.length === 0 || tooMany || !!active || start.isPending;

  const why = readOnly
    ? "Read Only Mode is enabled"
    : ids.length === 0
      ? "Nothing to work here"
      : tooMany
        ? `A run takes at most ${MAX_GOAL_BEADS} beads`
        : active
          ? `Goal run ${active.id} is already active (${active.state})`
          : `Work ${ids.length} bead${ids.length === 1 ? "" : "s"} in one goal run`;

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        title={why}
        aria-label={`${label} (${ids.length} beads)`}
        onClick={() => setOpen(true)}
        className={cn(
          "flex h-7 flex-shrink-0 items-center gap-[5px] rounded-[8px] border border-border bg-[var(--surface-2)] px-[9px] text-[11.5px] font-[550] text-[var(--text-2)]",
          "enabled:hover:border-[var(--brand)] enabled:hover:text-[var(--text)] disabled:opacity-45",
          className,
        )}
      >
        <Icon name="rocket" size={13} />
        <span>{label}</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-w-[440px] flex-col gap-3 rounded-2xl border border-border bg-[var(--surface)] p-5">
          <DialogTitle className="text-[15px] font-[650]">
            Start a goal run on {ids.length} bead{ids.length === 1 ? "" : "s"}?
          </DialogTitle>
          <p className="m-0 text-[12.5px] leading-[1.5] text-[var(--text-2)]">
            Claude Code works these in one background session, committing per bead on a new
            branch. The set is fixed when the run starts, so anything filed along the way waits
            for the next one.
          </p>
          <ul className="m-0 max-h-[180px] list-none overflow-y-auto rounded-lg border border-border bg-[var(--surface-2)] p-2 font-mono text-[11.5px] text-[var(--text-2)]">
            {ids.map((id) => (
              <li key={id}>{id}</li>
            ))}
          </ul>
          {idleSession && (
            <p className="m-0 rounded-lg border border-border bg-[var(--surface-2)] p-2 text-[12px] leading-[1.5] text-[var(--text-2)]">
              {idleSession.name ? `"${idleSession.name}"` : `pid ${idleSession.pid}`} is an idle
              interactive session in this project folder. Starting this run switches that tree to a
              goal/ branch under it.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="h-8 rounded-[9px] border border-border px-3 text-[12.5px] font-[550] text-[var(--text-2)]"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={start.isPending}
              onClick={() =>
                start.mutate(ids, {
                  onSuccess: () => setOpen(false),
                })
              }
              className="h-8 rounded-[9px] px-3 text-[12.5px] font-[550] text-white disabled:opacity-60"
              style={{ background: "var(--brand)" }}
            >
              {start.isPending ? "Starting…" : "Start run"}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
