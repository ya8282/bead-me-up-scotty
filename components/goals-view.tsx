"use client";
import * as React from "react";
import { useApp } from "@/components/app-context";
import { Icon } from "@/components/icons";
import { CopyableId } from "@/components/copyable-id";
import { useGoalFeed, useGoalRuns } from "@/hooks/use-goal";
import { fmtDateTime, relTime } from "@/lib/beads-view";
import { GoalQuestion } from "@/components/goal-question";
import { DescriptionContent } from "@/components/description-content";
import type { GoalFeedItem, GoalPrompt, GoalRun } from "@/lib/api-client";
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
const KINDS = Object.keys(KIND_LABEL) as GoalFeedItem["kind"][];
/** Sentinel for the source picker; no transcript source is ever this. */
const ALL = "";

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
              prompt={feedQuery.data?.prompt ?? null}
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
  prompt,
  loading,
  error,
}: {
  run: GoalRun;
  items: GoalFeedItem[];
  screen: string | null;
  prompt: GoalPrompt | null;
  loading: boolean;
  error: Error | null;
}) {
  const scroller = React.useRef<HTMLDivElement>(null);
  // Filters are per-run: RunOutput is keyed by run id, so picking another run
  // remounts with them cleared.
  const [query, setQuery] = React.useState("");
  const [source, setSource] = React.useState(ALL);
  // Empty means every kind, so a new kind is visible without touching this.
  const [kinds, setKinds] = React.useState<ReadonlySet<GoalFeedItem["kind"]>>(new Set());
  const sources = React.useMemo(() => [...new Set(items.map((i) => i.source))], [items]);
  // A source that only appears later must not leave the feed silently empty.
  const pickedSource = sources.includes(source) ? source : ALL;

  const shown = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter(
      (it) =>
        (pickedSource === ALL || it.source === pickedSource) &&
        (kinds.size === 0 || kinds.has(it.kind)) &&
        (!needle || it.text.toLowerCase().includes(needle) || it.source.toLowerCase().includes(needle)),
    );
  }, [items, query, pickedSource, kinds]);

  const filtering = !!query.trim() || pickedSource !== ALL || kinds.size > 0;
  const clear = () => {
    setQuery("");
    setSource(ALL);
    setKinds(new Set());
  };

  // Follow new output only while the reader is already at the bottom, so
  // scrolling back to read something is not yanked away by the next poll.
  const following = React.useRef(true);
  React.useEffect(() => {
    const el = scroller.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [shown.length, screen]);

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

      {items.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-[9px]">
          <input
            type="search"
            aria-label="Filter output"
            placeholder="Filter output"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 min-w-[140px] flex-1 rounded-[8px] border border-border bg-[var(--surface)] px-[9px] text-[12.5px] outline-none focus:border-[var(--brand)]"
          />
          {sources.length > 1 && (
            <select
              aria-label="Filter by source"
              value={pickedSource}
              onChange={(e) => setSource(e.target.value)}
              className="h-8 max-w-[220px] rounded-[8px] border border-border bg-[var(--surface)] px-[7px] text-[12.5px] outline-none"
            >
              <option value={ALL}>All sources</option>
              {sources.map((src) => (
                <option key={src} value={src}>
                  {src}
                </option>
              ))}
            </select>
          )}
          <div role="group" aria-label="Filter by kind" className="flex flex-wrap gap-[5px]">
            {KINDS.map((kind) => {
              const on = kinds.has(kind);
              return (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setKinds((prev) => {
                      const next = new Set(prev);
                      if (!next.delete(kind)) next.add(kind);
                      return next;
                    })
                  }
                  className={cn(
                    "h-8 rounded-[8px] border px-[9px] text-[12px]",
                    on
                      ? "border-[var(--brand)] bg-[var(--brand-weak)] text-[var(--text)]"
                      : "border-border text-[var(--text-2)] hover:bg-[var(--surface-2)]",
                  )}
                >
                  {KIND_LABEL[kind]}
                </button>
              );
            })}
          </div>
          {filtering && (
            <>
              <span role="status" className="text-[11.5px] text-[var(--text-3)]">
                {shown.length} of {items.length}
              </span>
              <button
                type="button"
                onClick={clear}
                className="h-8 rounded-[8px] px-2 text-[12px] text-[var(--brand)] hover:underline"
              >
                Clear
              </button>
            </>
          )}
        </div>
      )}

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
        ) : shown.length === 0 ? (
          <p className="m-0 p-6 text-center text-[13px] text-[var(--text-3)]">
            No output matches these filters.
          </p>
        ) : (
          <ol aria-label="Feed" className="m-0 flex list-none flex-col p-0">
            {shown.map((it) => (
              <FeedRow key={it.id} item={it} />
            ))}
          </ol>
        )}

        {screen && (
          <div className="mt-3">
            <GoalQuestion run={run} prompt={prompt} screen={screen} />
          </div>
        )}
      </div>
    </section>
  );
}

function FeedRow({ item }: { item: GoalFeedItem }) {
  const { projectId } = useApp();
  const sub = item.source !== "main";
  // What the run says is markdown it wrote for a person to read, so tables and
  // lists render as such. Tool and command lines are argv, not prose.
  const prose = item.kind === "text";
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
        {prose ? (
          <DescriptionContent
            text={item.text}
            projectId={projectId}
            className="break-words text-[13px] leading-[1.5] text-[var(--text)]"
          />
        ) : (
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
        )}
      </div>
    </li>
  );
}
