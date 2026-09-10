"use client";
import * as React from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { Bead } from "@/lib/schema";
import { BeadCard } from "./bead-card";
import { cn } from "@/lib/utils";

export interface ColumnDef {
  id: string;
  name: string;
  color: string;
  cmd: string;
  droppable: boolean;
}

export function Column({
  col,
  cards,
  childCounts,
  control,
  manualSort = true,
  dropId,
  grouped = false,
  selectMode = false,
  selectedIds,
  onSelectToggleAction,
}: {
  col: ColumnDef;
  cards: Bead[];
  /** id -> number of parent-child children, computed once by the board. */
  childCounts?: Map<string, number>;
  control?: React.ReactNode;
  manualSort?: boolean;
  selectMode?: boolean;
  selectedIds?: Set<string>;
  onSelectToggleAction?: (id: string) => void;
  /**
   * Droppable id, when the same column is rendered more than once (one row per
   * epic). Droppable ids must be unique, so grouped rows namespace theirs.
   */
  dropId?: string;
  /** Grouped rows are shorter and narrower, and scroll as a page rather than each column. */
  grouped?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId ?? col.id, disabled: !col.droppable });

  return (
    <section
      className={cn(
        "flex min-h-0 flex-shrink-0 flex-col",
        grouped ? "w-[270px]" : "w-[296px]",
      )}
    >
      <div className="flex flex-shrink-0 items-center gap-2 px-1 pb-3">
        <span className="h-[9px] w-[9px] rounded-[3px]" style={{ background: col.color }} />
        <span className="text-[13px] font-semibold tracking-[-.005em]">{col.name}</span>
        <span className="rounded-full border border-border bg-[var(--surface-2)] px-2 py-px font-mono text-[11.5px] text-[var(--text-3)]">
          {cards.length}
        </span>
        <span className="flex-1" />
        {control ?? <span className="font-mono text-[10.5px] text-[var(--text-3)]">{col.cmd}</span>}
      </div>

      <div
        ref={setNodeRef}
        className={cn(
          "bd-scroll flex flex-col gap-[10px] overflow-x-hidden rounded-xl p-[4px_4px_14px] transition-[background,outline]",
          grouped ? "min-h-[70px]" : "min-h-0 flex-1 overflow-y-auto",
          isOver && col.droppable
            ? "bg-[var(--brand-weak)] outline-2 outline-dashed outline-[var(--brand)] -outline-offset-2"
            : "outline-2 outline-transparent",
        )}
      >
        <SortableContext items={cards.map((b) => b.id)} strategy={manualSort ? verticalListSortingStrategy : () => null}>
          {cards.map((b) => (
            <BeadCard
              key={b.id}
              bead={b}
              childCount={childCounts?.get(b.id) ?? 0}
              // A closed bead has no work left, so it stays openable rather
              // than selectable even while select mode is on.
              selectable={selectMode && b.status !== "closed"}
              selected={selectedIds?.has(b.id) ?? false}
              onSelectToggleAction={onSelectToggleAction}
            />
          ))}
        </SortableContext>
        {cards.length === 0 && (
          <div className="rounded-[11px] border-[1.5px] border-dashed border-border p-[22px_12px] text-center text-[12px] text-[var(--text-3)]">
            No beads
          </div>
        )}
      </div>
    </section>
  );
}
