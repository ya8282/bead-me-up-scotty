import type { Bead } from "./schema";
import { isBlocked, parentOf } from "./beads-view";

/**
 * The board's column model — shared by the Board (Kanban) and List views so they
 * agree on which column a bead belongs to and the column ordering used for the
 * manual run-order. Column order here defines top-to-bottom order in the List.
 */
export interface BoardColumn {
  id: string;
  name: string;
  color: string;
  cmd: string;
  droppable: boolean;
  /** The bd status a drop into this column sets (undefined = not a real status). */
  status?: string;
  test: (b: Bead, blocked: boolean) => boolean;
}

export const BOARD_COLUMNS: BoardColumn[] = [
  { id: "backlog", name: "Backlog", color: "#64748b", cmd: "deferred", droppable: true, status: "deferred", test: (b) => b.status === "deferred" },
  { id: "ready", name: "Ready", color: "#3b82f6", cmd: "bd ready", droppable: true, status: "open", test: (b, blocked) => b.status === "open" && !blocked },
  { id: "in_progress", name: "In Progress", color: "#d97706", cmd: "in_progress", droppable: true, status: "in_progress", test: (b) => b.status === "in_progress" || b.status === "hooked" },
  { id: "blocked", name: "Blocked", color: "#ef4444", cmd: "bd blocked", droppable: false, test: (b, blocked) => blocked && b.status !== "deferred" && b.status !== "closed" },
  { id: "done", name: "Done", color: "#16a34a", cmd: "closed", droppable: true, status: "closed", test: (b) => b.status === "closed" },
];

export const COLUMN_ORDER: string[] = BOARD_COLUMNS.map((c) => c.id);

/** Which board column a bead belongs to (first matching test), or null. */
export function colOf(bead: Bead, index: Map<string, Bead>): string | null {
  const blocked = isBlocked(bead, index);
  for (const c of BOARD_COLUMNS) if (c.test(bead, blocked)) return c.id;
  return null;
}

export type BoardSortMode = "priority" | "updated" | "manual";

function updatedTime(card: Bead): number {
  const parsed = Date.parse(card.updated_at || card.created_at || "");
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function byUpdatedThenPriority(left: Bead, right: Bead): number {
  const updatedDiff = updatedTime(right) - updatedTime(left);
  return updatedDiff || left.priority - right.priority || left.id.localeCompare(right.id);
}

function byPriorityThenUpdated(first: Bead, second: Bead): number {
  return first.priority - second.priority || byUpdatedThenPriority(first, second);
}

/** Sort cards according to the board's explicit display mode. */
export function sortBoardCards(
  cards: Bead[], mode: BoardSortMode, order?: string[],
): Bead[] {
  const rank = new Map((order ?? []).map((id, i) => [id, i]));

  return [...cards].sort((cardA, cardB) => {
    if (mode === "updated") return byUpdatedThenPriority(cardA, cardB);
    if (mode === "priority") return byPriorityThenUpdated(cardA, cardB);

    const rankA = rank.get(cardA.id) ?? Number.POSITIVE_INFINITY;
    const rankB = rank.get(cardB.id) ?? Number.POSITIVE_INFINITY;
    if (rankA !== rankB) return rankA - rankB;
    return cardA.priority - cardB.priority;
  });
}

/** Preserve saved manual order, falling back to priority for unranked cards. */
export function sortByOrder(cards: Bead[], order?: string[]): Bead[] {
  return sortBoardCards(cards, "manual", order);
}

/** One board row: the same columns, restricted to one parent's children. */
export interface BoardGroup {
  /** Parent bead id, or "none" for beads with no parent. */
  key: string;
  label: string;
  /** Ids a goal run would work: everything in the row that is not closed. */
  runnableIds: string[];
  columns: { col: BoardColumn; cards: Bead[] }[];
}

/**
 * Split already-built columns into one row per parent bead, preserving each
 * column's order. Keyed on the parent-child EDGE via parentOf(), so it agrees
 * with the drawer and the epic graph rather than re-deriving the hierarchy.
 *
 * Epics are filtered out of the board upstream, so a parent only ever appears
 * as a row label here, never as a card. Rows whose beads are all closed are
 * dropped: the point of grouping is seeing what is left in an epic.
 */
export function groupColumnsByParent(
  columns: { col: BoardColumn; cards: Bead[] }[],
  index: Map<string, Bead>,
): BoardGroup[] {
  const groups = new Map<string, BoardGroup>();
  for (const [columnIndex, { cards }] of columns.entries()) {
    for (const bead of cards) {
      const parent = parentOf(bead, index);
      const key = parent?.id ?? "none";
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          label: parent ? parent.title : "No epic",
          runnableIds: [],
          columns: columns.map((c) => ({ col: c.col, cards: [] as Bead[] })),
        };
        groups.set(key, group);
      }
      group.columns[columnIndex].cards.push(bead);
      if (bead.status !== "closed") group.runnableIds.push(bead.id);
    }
  }
  return [...groups.values()]
    .filter((g) => g.runnableIds.length > 0)
    .sort(
      (a, b) =>
        // Parentless work last, then alphabetical, then by id for stability.
        Number(a.key === "none") - Number(b.key === "none") ||
        a.label.localeCompare(b.label) ||
        a.key.localeCompare(b.key),
    );
}
