"use client";
import * as React from "react";
import { useApp } from "@/components/app-context";
import { Icon } from "@/components/icons";
import { CopyableId } from "@/components/copyable-id";
import { useGoalFeed, useGoalRuns } from "@/hooks/use-goal";
import { fmtDateTime, relTime } from "@/lib/beads-view";
import type { GoalFeedItem, GoalRun } from "@/lib/api-client";
import { cn } from "@/lib/utils";

const STATE_COLOR: Record<string, string> = {
  working: "var(--brand)",
  blocked: "#d97706",
  done: "#16a34a",
};

function StateBadge({ state }: { state: string }) {
  const color = STATE_COLOR[state] ?? "var(--text-3)";
  return (
    <span
      className="inline-flex flex-shrink-0 items-center gap-[5px] rounded-full border px-[7px] py-px text-[11px] font-[550]"
      style={{ color, borderColor: color }}
    >
      <span className="h-[6px] w-[6px] rounded-full" style={{ background: color }} />
      {state === "blocked" ? "waiting on you" : state}
    </span>
  );
}

const KIND_LABEL: Record<GoalFeedItem["kind"], string> = {
  command: "Started",
  prompt: "Prompt",
  text: "Says",
  tool: "Runs",
};

function clock(iso: string): string {
  const d = new Date(iso);
  // 24-hour so the column never wraps an AM/PM suffix onto a second line.
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
}

/**
 * Goal runs, watched from inside Scotty: the runs this project has started, and
 * a live feed of the selected one merged from its own transcript and its
 * subagents'. The same view `goalwatch` gives in a terminal, without leaving
 * the board to get it.
 */
export function GoalsView() {
  const { projectId } = useApp();
  const runsQuery = useGoalRuns(projectId);
  const runs = React.useMemo(() => runsQuery.data?.runs ?? [], [runsQuery.data]);
  const [picked, setPicked] = React.useState<string | null>(null);
  // Newest run until one is picked; runs arrive newest first.
  const run = runs.find((r) => r.id === picked) ?? runs[0] ?? null;
  const feedQuery = useGoalFeed(projectId, run?.id ?? null, run?.live ?? false);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-4">
        <Icon name="bot" size={18} className="text-[var(--text-2)]" />
        <h1 className="text-[15px] font-[650]">Goals</h1>
        <span className="text-[12px] text-[var(--text-3)]">
          · Claude Code /goal runs in this project, and what they are doing
        </span>
      </div>

      {runsQuery.error ? (
        <p role="alert" className="m-0 p-8 text-center text-[13px] text-[var(--text-2)]">
          {(runsQuery.error as Error).message}
        </p>
      ) : runsQuery.isLoading ? (
        <p className="m-0 p-8 text-center text-[13px] text-[var(--text-3)]">Loading goal runs…</p>
      ) : runs.length === 0 ? (
        <p className="m-0 p-8 text-center text-[13px] text-[var(--text-3)]">
          No goal runs in this project yet. Start one from the Board with Run goal.
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <nav
            aria-label="Goal runs"
            className="bd-scroll max-h-[35%] flex-shrink-0 overflow-y-auto border-b border-border p-2 md:max-h-none md:w-[280px] md:border-b-0 md:border-r"
          >
            <ul className="m-0 flex list-none flex-col gap-[2px] p-0">
              {runs.map((r) => (
                <li key={r.id}>
                  <RunRow run={r} active={r.id === run?.id} onPick={() => setPicked(r.id)} />
                </li>
              ))}
            </ul>
          </nav>
          {run && (
            <RunOutput
              key={run.id}
              run={feedQuery.data?.run ?? run}
              items={feedQuery.data?.items ?? []}
              screen={feedQuery.data?.screen ?? null}
              loading={feedQuery.isLoading}
              error={feedQuery.error as Error | null}
            />
          )}
        </div>
      )}
    </div>
  );
}

function RunRow({ run, active, onPick }: { run: GoalRun; active: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex w-full flex-col gap-1 rounded-[9px] px-3 py-[9px] text-left",
        active ? "bg-[var(--brand-weak)]" : "hover:bg-[var(--surface-2)]",
      )}
    >
      <span className="flex items-center gap-2">
        <span className="font-mono text-[12px] text-[var(--text-2)]">{run.id}</span>
        <span className="flex-1" />
        <StateBadge state={run.state} />
      </span>
      {run.name && <span className="truncate text-[12.5px] text-[var(--text)]">{run.name}</span>}
      <span className="text-[11px] text-[var(--text-3)]" title={fmtDateTime(new Date(run.startedAt).toISOString())}>
        started {relTime(new Date(run.startedAt).toISOString())}
      </span>
    </button>
  );
}

function RunOutput({
  run,
  items,
  screen,
  loading,
  error,
}: {
  run: GoalRun;
  items: GoalFeedItem[];
  screen: string | null;
  loading: boolean;
  error: Error | null;
}) {
  const scroller = React.useRef<HTMLDivElement>(null);
  // Follow new output only while the reader is already at the bottom, so
  // scrolling back to read something is not yanked away by the next poll.
  const following = React.useRef(true);
  React.useEffect(() => {
    const el = scroller.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [items.length, screen]);

  return (
    <section aria-label="Run output" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        <span className="font-mono text-[13px] font-semibold">{run.id}</span>
        <StateBadge state={run.state} />
        {run.name && <span className="min-w-0 truncate text-[13px] text-[var(--text-2)]">{run.name}</span>}
        <span className="flex-1" />
        <CopyableId
          id={`claude attach ${run.id}`}
          className="rounded-md border border-border bg-[var(--surface-2)] px-[7px] py-[2px] font-mono text-[11.5px] text-[var(--text-2)] no-underline"
        />
      </div>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="bd-scroll min-h-0 flex-1 overflow-y-auto px-5 py-3"
      >
        {error ? (
          <p role="alert" className="m-0 p-6 text-center text-[13px] text-[var(--text-2)]">
            {error.message}
          </p>
        ) : loading && items.length === 0 ? (
          <p className="m-0 p-6 text-center text-[13px] text-[var(--text-3)]">Loading output…</p>
        ) : items.length === 0 ? (
          <p className="m-0 p-6 text-center text-[13px] text-[var(--text-3)]">
            No output recorded for this run yet.
          </p>
        ) : (
          <ol aria-label="Feed" className="m-0 flex list-none flex-col p-0">
            {items.map((it) => (
              <FeedRow key={it.id} item={it} />
            ))}
          </ol>
        )}

        {screen && (
          <div
            role="region"
            aria-label="Waiting on you"
            className="mt-3 rounded-[11px] border p-3"
            style={{ borderColor: "#d97706", background: "color-mix(in srgb, #d97706 7%, var(--surface))" }}
          >
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[12.5px]">
              <span className="font-semibold" style={{ color: "#d97706" }}>
                Waiting on you
              </span>
              <span className="text-[var(--text-2)]">
                Its latest screen is below. Answer it with{" "}
                <CopyableId id={`claude attach ${run.id}`} className="font-mono text-[12px]" /> in a terminal.
              </span>
            </div>
            <pre className="bd-scroll m-0 max-h-[320px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-[1.5] text-[var(--text)]">
              {screen}
            </pre>
          </div>
        )}
      </div>
    </section>
  );
}

function FeedRow({ item }: { item: GoalFeedItem }) {
  const sub = item.source !== "main";
  return (
    <li className="grid grid-cols-[64px_1fr] gap-x-3 border-b border-border/60 py-[7px] last:border-b-0">
      <time dateTime={item.at} title={fmtDateTime(item.at)} className="pt-px font-mono text-[11px] text-[var(--text-3)]">
        {clock(item.at)}
      </time>
      <div className="min-w-0">
        <div className="mb-[2px] flex flex-wrap items-center gap-[6px] text-[11px]">
          <span className="font-semibold text-[var(--text-2)]">{KIND_LABEL[item.kind]}</span>
          {sub && (
            <span className="max-w-full truncate rounded-md bg-[var(--surface-2)] px-[6px] py-px text-[var(--text-3)]" title={item.source}>
              {item.source}
            </span>
          )}
        </div>
        <div
          className={cn(
            "break-words text-[var(--text)]",
            item.kind === "tool" || item.kind === "command"
              ? "font-mono text-[12px] text-[var(--text-2)]"
              : "whitespace-pre-wrap text-[13px] leading-[1.5]",
          )}
        >
          {item.text}
        </div>
      </div>
    </li>
  );
}
