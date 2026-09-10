"use client";
import * as React from "react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
  type DragEndEvent,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { Icon } from "@/components/icons";
import { useApp } from "@/components/app-context";
import { useSetStatus } from "@/hooks/use-beads";
import { useOrder, useSetOrder } from "@/hooks/use-order";
import { useBoardPrefs } from "@/hooks/use-board-prefs";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { useUrlState } from "@/hooks/use-url-state";
import { useGoalRuns } from "@/hooks/use-goal";
import { isBlocked, childrenCountMap, epicProgress } from "@/lib/beads-view";
import { FilterBar } from "@/components/filter-bar";
import { matchesFilters, labelOptionsFrom, assigneeOptionsFrom } from "@/lib/filters";
import {
  BOARD_COLUMNS as COLUMNS,
  sortBoardCards,
  groupColumnsByParent,
  type BoardSortMode,
} from "@/lib/board-columns";
import { cn } from "@/lib/utils";
import { Column } from "./column";
import { RunGoalButton } from "./run-goal-button";
import type { Bead } from "@/lib/schema";

/** Separates a group key from a column id in a grouped row's droppable id. */
const DROP_SEP = "::";

export function Board() {
  const { beads, index, humanAllowlist, openCreate, loading, projectId, readOnly } = useApp();
  const setStatus = useSetStatus();
  const { data: orderData } = useOrder(projectId);
  const setOrder = useSetOrder(projectId);
  const { prefs: boardPrefs, setPrefs: setBoardPrefs } = useBoardPrefs();
  const orders = React.useMemo(() => orderData?.orders ?? {}, [orderData]);
  const { filters, setFilters, showArchived, setShowArchived, clearFilters } =
    useUrlFilters();
  const { searchParams, updateUrl } = useUrlState();
  // Derived from ALL beads (not the filtered set) so selecting one label
  // doesn't make the remaining options vanish from the dropdown.
  const labelOptions = React.useMemo(() => labelOptionsFrom(beads), [beads]);
  const assigneeOptions = React.useMemo(() => assigneeOptionsFrom(beads), [beads]);
  // One pass over all beads, not childrenOf() per card — that would be O(n^2)
  // on a large board.
  const childCounts = React.useMemo(() => childrenCountMap(beads), [beads]);
  // Time-window filter for the Done column: null = all, else "closed within N days".
  const doneParam = Number(searchParams.get("done"));
  const doneWindow = [7, 28, 90, 365].includes(doneParam) ? doneParam : null;
  const setDoneWindow = React.useCallback(
    (days: number | null) => {
      updateUrl((params) => {
        if (days === null) params.delete("done");
        else params.set("done", String(days));
      });
    },
    [updateUrl],
  );
  // Mount-time "now" for the window cutoff — captured once (day-granular, so it
  // needn't tick) and kept out of render to satisfy the no-impure-call rule.
  const [now] = React.useState(() => Date.now());

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const matchFilters = React.useCallback(
    (b: Bead) => {
      if (b.issue_type === "epic") return false;
      if (!showArchived && (b.labels ?? []).includes("archived")) return false;
      return matchesFilters(b, filters, humanAllowlist);
    },
    [filters, showArchived, humanAllowlist],
  );

  const visible = React.useMemo(() => beads.filter(matchFilters), [beads, matchFilters]);
  const columns = React.useMemo(
    () =>
      COLUMNS.map((c) => {
        let cards = visible.filter((b) => c.test(b, isBlocked(b, index)));
        // Done column: optionally keep only beads closed within the chosen window.
        if (c.id === "done" && doneWindow !== null) {
          const cutoff = now - doneWindow * 86_400_000;
          cards = cards.filter((b) => {
            const t = Date.parse(b.closed_at || b.updated_at || "");
            return Number.isFinite(t) && t >= cutoff;
          });
        }
        return {
          col: c,
          cards: sortBoardCards(cards, boardPrefs.sortMode, orders[c.id]),
        };
      }),
    [visible, index, orders, boardPrefs.sortMode, doneWindow, now],
  );

  // Hide the Blocked column when it's empty, unless the user pinned it to always
  // show (bead mo3). Drag logic below still uses the full `columns` set; a hidden
  // Blocked column has zero cards, so nothing is ever dropped into or out of it.
  const shownColumns = React.useMemo(
    () =>
      columns.filter(
        ({ col, cards }) =>
          col.id !== "blocked" || cards.length > 0 || boardPrefs.blockedColumn === "always",
      ),
    [columns, boardPrefs.blockedColumn],
  );

  const grouped = boardPrefs.groupBy === "epic";
  const groups = React.useMemo(
    () => (grouped ? groupColumnsByParent(shownColumns, index) : []),
    [grouped, shownColumns, index],
  );
  const { data: goalData } = useGoalRuns(projectId, !readOnly);
  const activeRun = goalData?.active ?? null;

  // Select mode is the touch-first way to build a goal set: tapping a card picks
  // it instead of opening it, and dragging is off while it is on.
  const [selectMode, setSelectMode] = React.useState(false);
  const [selectedIds, setSelectedIds] = React.useState<ReadonlySet<string>>(new Set());
  const toggleSelected = React.useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const leaveSelectMode = React.useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, []);
  // Beads can disappear from view (filters, a status change, another writer), and
  // a set holding ids the board no longer shows would submit invisible work.
  const selectedVisible = React.useMemo(
    () => visible.filter((b) => selectedIds.has(b.id)).map((b) => b.id),
    [visible, selectedIds],
  );
  const selectProps = {
    selectMode,
    selectedIds: selectedIds as Set<string>,
    onSelectToggleAction: toggleSelected,
  };

  // Which column each visible bead currently sits in (drag targets resolve here).
  const colOfBead = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const { col, cards } of columns) for (const b of cards) m.set(b.id, col.id);
    return m;
  }, [columns]);

  function onDragEnd(e: DragEndEvent) {
    if (readOnly) return;
    const activeId = String(e.active.id);
    const overRaw = e.over?.id ? String(e.over.id) : null;
    if (!overRaw) return;

    const activeCol = colOfBead.get(activeId);
    if (!activeCol) return;

    // `over` is a column id (dropped on empty area) or a bead id (over a card).
    // Grouped rows namespace their column ids, so strip the group prefix first;
    // which row a card lands in follows from its parent, not from the drop.
    const overColRaw = overRaw.includes(DROP_SEP) ? overRaw.split(DROP_SEP)[1] : overRaw;
    const overCol = COLUMNS.some((c) => c.id === overColRaw)
      ? overColRaw
      : colOfBead.get(overColRaw);
    if (!overCol) return;

    if (overCol !== activeCol) {
      // Cross-column → status change (existing behavior).
      const target = COLUMNS.find((c) => c.id === overCol);
      if (!target || !target.droppable || !target.status) return;
      const bead = index.get(activeId);
      if (!bead || bead.status === target.status) return;
      setStatus.mutate({ id: activeId, status: target.status });
      return;
    }

    // Manual order is one list per column for the whole board, so reordering
    // inside a single epic's row has nothing coherent to persist.
    if (boardPrefs.sortMode !== "manual" || grouped) return;

    // Within-column → reorder + persist the manual order.
    const ids = (columns.find((c) => c.col.id === activeCol)?.cards ?? []).map((b) => b.id);
    const oldIndex = ids.indexOf(activeId);
    const newIndex = overRaw === activeCol ? ids.length - 1 : ids.indexOf(overRaw);
    if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
    setOrder.mutate({ columnId: activeCol, ids: arrayMove(ids, oldIndex, newIndex) });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-shrink-0 items-center gap-3 border-b border-border bg-[var(--surface)] p-[14px_22px]">
        <div className="mr-1 flex flex-col gap-px">
          <h1 className="m-0 text-base font-[650] tracking-[-.01em]">Board</h1>
          <span className="text-[11.5px] text-[var(--text-3)]">
            {visible.length} beads · live from <span className="font-mono">bd list</span>
          </span>
        </div>

        <FilterBar
          filters={filters}
          onChange={setFilters}
          labelOptions={labelOptions}
          assigneeOptions={assigneeOptions}
          showArchived={showArchived}
          onShowArchived={setShowArchived}
          onClearAllAction={clearFilters}
        />

        <label
          className="flex h-9 flex-shrink-0 items-center gap-[7px] rounded-[9px] border border-border bg-[var(--surface-2)] px-[10px] text-[12.5px] text-[var(--text-2)]"
          title="Group the board into one row per epic"
        >
          <span className="font-medium">Group by</span>
          <select
            aria-label="Group board rows"
            value={boardPrefs.groupBy}
            onChange={(e) =>
              setBoardPrefs({
                ...boardPrefs,
                groupBy: e.target.value === "epic" ? "epic" : "none",
              })
            }
            className="cursor-pointer border-none bg-transparent text-[12.5px] font-semibold text-[var(--text)] outline-none"
          >
            <option value="none">Nothing</option>
            <option value="epic">Epic</option>
          </select>
        </label>

        <label
          className="flex h-9 flex-shrink-0 items-center gap-[7px] rounded-[9px] border border-border bg-[var(--surface-2)] px-[10px] text-[12.5px] text-[var(--text-2)]"
          title={
            boardPrefs.sortMode === "manual"
              ? "Drag to reorder cards or move them between status columns"
              : "Drag between status columns; choose Manual to reorder within a column"
          }
        >
          <span className="font-medium">Sort</span>
          <select
            aria-label="Sort board cards"
            value={boardPrefs.sortMode}
            onChange={(e) =>
              setBoardPrefs({
                ...boardPrefs,
                sortMode: e.target.value as BoardSortMode,
              })
            }
            className="cursor-pointer border-none bg-transparent text-[12.5px] font-semibold text-[var(--text)] outline-none"
          >
            <option value="priority">Priority</option>
            <option value="updated">Recently updated</option>
            <option value="manual">Manual</option>
          </select>
        </label>

        {!readOnly && (
          <button
            type="button"
            aria-pressed={selectMode}
            onClick={() => (selectMode ? leaveSelectMode() : setSelectMode(true))}
            title="Pick several beads to hand to one goal run"
            className={cn(
              "flex h-9 flex-shrink-0 items-center gap-[6px] rounded-[9px] border px-[12px] text-[12.5px] font-[550]",
              selectMode
                ? "border-[var(--brand)] bg-[var(--brand-weak)] text-[var(--brand)]"
                : "border-border bg-[var(--surface-2)] text-[var(--text-2)]",
            )}
          >
            <Icon name="check" size={14} />
            <span>Select</span>
          </button>
        )}

        {!readOnly && (
          <button
            onClick={() => openCreate()}
            className="flex h-9 flex-shrink-0 items-center gap-[6px] rounded-[9px] px-[14px] text-[13px] font-[550] text-white"
            style={{ background: "var(--brand)", boxShadow: "0 2px 8px -2px var(--brand)" }}
          >
            <Icon name="plus" size={15} />
            <span>New</span>
          </button>
        )}
      </header>

      {activeRun && (
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-border bg-[var(--surface-2)] px-[22px] py-2 text-[12px] text-[var(--text-2)]">
          <Icon name="rocket" size={13} />
          <span>
            Goal run <span className="font-mono">{activeRun.id}</span> is working this project
            {activeRun.state === "blocked" ? " and is waiting for a decision" : ""}.
          </span>
          <code className="rounded-md border border-border bg-[var(--surface)] px-[6px] py-px font-mono text-[11px]">
            claude attach {activeRun.id}
          </code>
        </div>
      )}

      <div
        className={cn(
          "bd-scroll min-h-0 flex-1 p-[18px_22px]",
          grouped ? "overflow-y-auto" : "overflow-x-auto overflow-y-hidden",
        )}
      >
        {loading && beads.length === 0 ? (
          <div className="text-[13px] text-[var(--text-3)]">Loading beads…</div>
        ) : (
          <DndContext
            sensors={selectMode ? [] : sensors}
            collisionDetection={closestCorners}
            onDragEnd={onDragEnd}
          >
            {grouped ? (
              <div className="flex flex-col gap-5">
                {groups.length === 0 ? (
                  <p className="m-0 text-[13px] text-[var(--text-3)]">
                    No open work to group. Epics with everything closed are hidden here.
                  </p>
                ) : (
                  groups.map((group) => {
                    const progress =
                      group.key === "none" ? null : epicProgress(group.key, beads);
                    return (
                      <section
                        key={group.key}
                        aria-label={`Epic: ${group.label}`}
                        className="flex flex-col gap-2"
                      >
                        <div className="flex items-center gap-2">
                          <h2 className="m-0 truncate text-[13px] font-[650]">{group.label}</h2>
                          <span className="flex-shrink-0 rounded-full border border-border bg-[var(--surface-2)] px-2 py-px font-mono text-[11px] text-[var(--text-3)]">
                            {progress
                              ? `${progress.closed}/${progress.total} closed`
                              : `${group.runnableIds.length} open`}
                          </span>
                          <RunGoalButton
                            ids={group.runnableIds}
                            label={group.key === "none" ? "Run goal on these" : "Run goal on epic"}
                          />
                        </div>
                        <div className="bd-scroll flex gap-4 overflow-x-auto pb-1">
                          {group.columns.map(({ col, cards }) => (
                            <Column
                              key={col.id}
                              col={col}
                              cards={cards}
                              childCounts={childCounts}
                              dropId={`${group.key}${DROP_SEP}${col.id}`}
                              grouped
                              manualSort={false}
                              {...selectProps}
                            />
                          ))}
                        </div>
                      </section>
                    );
                  })
                )}
              </div>
            ) : (
              <div className="flex h-full min-h-0 gap-4">
                {shownColumns.map(({ col, cards }) => (
                  <Column
                    key={col.id}
                    col={col}
                    cards={cards}
                    childCounts={childCounts}
                    manualSort={boardPrefs.sortMode === "manual"}
                    {...selectProps}
                    control={
                      col.id === "done" ? (
                        <select
                          value={doneWindow ?? ""}
                          onChange={(e) =>
                            setDoneWindow(e.target.value === "" ? null : Number(e.target.value))
                          }
                          title="Show only beads closed within this window"
                          className="cursor-pointer rounded-[7px] border border-border bg-[var(--surface-2)] px-[7px] py-[3px] text-[11px] text-[var(--text-2)] outline-none"
                        >
                          <option value="">All time</option>
                          <option value="7">Last 7 days</option>
                          <option value="28">Last 4 weeks</option>
                          <option value="90">Last 3 months</option>
                          <option value="365">Last 12 months</option>
                        </select>
                      ) : undefined
                    }
                  />
                ))}
              </div>
            )}
          </DndContext>
        )}
      </div>

      {/* Outside the scrolling area, so it stays reachable at phone width where
          the columns themselves scroll sideways. */}
      {selectMode && (
        <div
          role="region"
          aria-label="Selected beads"
          className="flex flex-shrink-0 flex-wrap items-center gap-3 border-t border-border bg-[var(--surface)] px-[22px] py-[10px]"
        >
          <span className="text-[12.5px] font-[550]">
            {selectedVisible.length} selected
          </span>
          <span className="text-[11.5px] text-[var(--text-3)]">
            {selectedVisible.length === 0
              ? "Tap beads to add them to a goal run"
              : "One run works them in order, committing per bead"}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
            disabled={selectedVisible.length === 0}
            className="h-7 rounded-[8px] border border-border px-[9px] text-[11.5px] font-[550] text-[var(--text-2)] disabled:opacity-45"
          >
            Clear
          </button>
          <RunGoalButton ids={selectedVisible} label="Run goal" />
        </div>
      )}
    </div>
  );
}
