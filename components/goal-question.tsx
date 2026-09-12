"use client";
import * as React from "react";
import { useApp } from "@/components/app-context";
import { CopyableId } from "@/components/copyable-id";
import { DescriptionContent } from "@/components/description-content";
import { useAnswerGoal, useGoalFeed } from "@/hooks/use-goal";
import type { GoalPrompt, GoalRun } from "@/lib/api-client";
import { cn } from "@/lib/utils";

const AMBER = "#d97706";

/** A multi-select starts from whatever the run's screen already has ticked. */
function ticked(prompt: GoalPrompt | null): ReadonlySet<number> {
  return new Set((prompt?.options ?? []).filter((o) => o.selected).map((o) => o.n));
}

/**
 * The question a waiting goal run is asking, answerable in place. Each choice
 * is the number the terminal would take; "Type something" opens a box whose
 * text is sent after it. Sending names the question by key, so if the run has
 * moved on by then the server refuses rather than answering the wrong thing.
 *
 * A single-select answer moves the run on by itself. A multi-select one is
 * ticked here and sent as a set, which advances to the next question or to the
 * run's own review screen — where "Submit answers" is just another choice.
 */
export function GoalQuestion({
  run,
  prompt,
  screen,
}: {
  run: GoalRun;
  prompt: GoalPrompt | null;
  screen: string | null;
}) {
  const { projectId, readOnly } = useApp();
  const answer = useAnswerGoal();
  const [typing, setTyping] = React.useState<number | null>(null);
  const [text, setText] = React.useState("");
  // The run repaints its next step a moment after an answer; until then the old
  // question is still on screen and must not be answered twice.
  const [sentKey, setSentKey] = React.useState<string | null>(null);
  const sent = !!prompt && sentKey === prompt.key;
  const disabled = readOnly || answer.isPending || sent;

  // Ticks for a multi-select, kept here until the set is sent. Reset in render
  // rather than an effect so a new question never shows the old question's ticks.
  const [chosen, setChosen] = React.useState<ReadonlySet<number>>(() => ticked(prompt));
  const shownKey = React.useRef(prompt?.key);
  if (shownKey.current !== prompt?.key) {
    shownKey.current = prompt?.key;
    setChosen(ticked(prompt));
  }

  const send = (options: number[], typed?: string) => {
    if (!prompt) return;
    answer.mutate(
      { runId: run.id, answer: { key: prompt.key, options, text: typed } },
      {
        onSuccess: () => {
          setSentKey(prompt.key);
          setTyping(null);
          setText("");
        },
      },
    );
  };

  return (
    <section
      aria-label={`Goal run ${run.id} is asking`}
      className="rounded-[12px] border p-4"
      style={{ borderColor: AMBER, background: `color-mix(in srgb, ${AMBER} 6%, var(--surface))` }}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2 text-[12.5px]">
        <span className="font-semibold" style={{ color: AMBER }}>
          Goal run {run.id} is asking
        </span>
        {run.name && <span className="min-w-0 truncate text-[var(--text-2)]">{run.name}</span>}
      </div>

      {prompt ? (
        <>
          {prompt.tabs && (
            <div className="mb-2 font-mono text-[11px] text-[var(--text-3)]">{prompt.tabs}</div>
          )}
          <DescriptionContent
            text={prompt.question || "Choose one:"}
            projectId={projectId}
            className="mb-3 text-[13.5px] font-[550] leading-[1.45] text-[var(--text)]"
          />
          <div role="group" aria-label="Choices" className="flex flex-col gap-2">
            {prompt.options.map((o) =>
              typing === o.n ? (
                <form
                  key={o.n}
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (text.trim()) send([o.n], text);
                  }}
                  className="flex flex-col gap-2 rounded-[9px] border border-[var(--brand)] bg-[var(--surface)] p-2"
                >
                  <textarea
                    autoFocus
                    aria-label="Your answer"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    rows={3}
                    maxLength={2000}
                    placeholder="Type your answer"
                    className="w-full resize-y rounded-[7px] border border-border bg-[var(--surface-2)] p-2 text-[13px] outline-none"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setTyping(null)}
                      className="h-8 rounded-[8px] border border-border px-3 text-[12.5px] text-[var(--text-2)]"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={disabled || !text.trim()}
                      className="h-8 rounded-[8px] px-3 text-[12.5px] font-[550] text-white disabled:opacity-50"
                      style={{ background: "var(--brand)" }}
                    >
                      {answer.isPending ? "Sending…" : "Send answer"}
                    </button>
                  </div>
                </form>
              ) : prompt.multi && !o.freeText ? (
                <label
                  key={o.n}
                  className={cn(
                    "flex cursor-pointer select-none items-start gap-[9px] rounded-[9px] border border-border bg-[var(--surface)] px-3 py-2",
                    disabled ? "cursor-default opacity-55" : "hover:border-[var(--brand)]",
                  )}
                >
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={chosen.has(o.n)}
                    onChange={() =>
                      setChosen((prev) => {
                        const next = new Set(prev);
                        if (!next.delete(o.n)) next.add(o.n);
                        return next;
                      })
                    }
                    className="mt-[3px] h-4 w-4 flex-shrink-0"
                    style={{ accentColor: "var(--brand)" }}
                  />
                  <span className="flex min-w-0 flex-col gap-[2px]">
                    <span className="text-[13px] font-[550] text-[var(--text)]">{o.label}</span>
                    {o.detail && <span className="text-[12px] leading-[1.4] text-[var(--text-2)]">{o.detail}</span>}
                  </span>
                </label>
              ) : (
                <button
                  key={o.n}
                  type="button"
                  disabled={disabled}
                  onClick={() => (o.freeText ? setTyping(o.n) : send([o.n]))}
                  className={cn(
                    "flex flex-col items-start gap-[2px] rounded-[9px] border border-border bg-[var(--surface)] px-3 py-2 text-left",
                    "enabled:hover:border-[var(--brand)] disabled:opacity-55",
                  )}
                >
                  <span className="text-[13px] font-[550] text-[var(--text)]">
                    {prompt.multi ? o.label : `${o.n}. ${o.label}`}
                  </span>
                  {o.detail && <span className="text-[12px] leading-[1.4] text-[var(--text-2)]">{o.detail}</span>}
                </button>
              ),
            )}
          </div>
          {prompt.multi && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={disabled}
                onClick={() => send([...chosen])}
                className="h-8 rounded-[8px] px-3 text-[12.5px] font-[550] text-white disabled:opacity-50"
                style={{ background: "var(--brand)" }}
              >
                {answer.isPending ? "Sending…" : "Send answers"}
              </button>
              <span className="text-[11.5px] text-[var(--text-3)]">
                {chosen.size === 0
                  ? "Nothing ticked — sending answers none of these."
                  : `${chosen.size} ticked. Sending moves the run to its next question.`}
              </span>
            </div>
          )}
          {sent && (
            <p role="status" className="m-0 mt-3 text-[12px] text-[var(--text-2)]">
              Sent. Waiting for the run to show its next step…
            </p>
          )}
        </>
      ) : (
        <p className="m-0 mb-2 text-[12.5px] text-[var(--text-2)]">
          Scotty can&rsquo;t read any choices on this screen. Answer it in a terminal with{" "}
          <CopyableId id={`claude attach ${run.id}`} className="font-mono text-[12px]" />.
        </p>
      )}

      {readOnly && (
        <p className="m-0 mt-3 text-[12px] text-[var(--text-2)]">
          Read Only Mode is on, so answering is turned off. Use the banner at the top to enable editing.
        </p>
      )}

      {screen && (
        <details className="mt-3" open={!prompt}>
          <summary className="cursor-pointer text-[12px] text-[var(--text-3)]">The run&rsquo;s screen</summary>
          <pre className="bd-scroll m-0 mt-2 max-h-[320px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-[1.5] text-[var(--text)]">
            {screen}
          </pre>
        </details>
      )}
      <p className="m-0 mt-3 text-[11.5px] text-[var(--text-3)]">
        To talk it through instead of choosing, attach in a terminal:{" "}
        <CopyableId id={`claude attach ${run.id}`} className="font-mono text-[11.5px]" />
      </p>
    </section>
  );
}

/** A waiting run that reads its own question, for lists like Needs You. */
export function WaitingGoalRun({ run }: { run: GoalRun }) {
  const { projectId } = useApp();
  const { data, error, isLoading } = useGoalFeed(projectId, run.id, true);
  if (error) {
    return (
      <p role="alert" className="m-0 rounded-[12px] border border-border p-4 text-[12.5px] text-[var(--text-2)]">
        Goal run {run.id} is waiting on you, but its screen could not be read: {(error as Error).message}
      </p>
    );
  }
  if (isLoading || !data) {
    return (
      <p className="m-0 rounded-[12px] border border-border p-4 text-[12.5px] text-[var(--text-3)]">
        Reading goal run {run.id}&rsquo;s question…
      </p>
    );
  }
  return <GoalQuestion run={data.run} prompt={data.prompt} screen={data.screen} />;
}
