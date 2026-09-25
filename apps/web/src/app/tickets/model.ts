import type { TicketPriority, TicketStatus } from "@feedbacks/schema/enums";
import { ACTIVE_STATUSES, BACKLOG_STATUSES, isClosedStatus } from "@feedbacks/schema/tickets";
import type { TFunction } from "i18next";
import { priorityLabel, priorityRank, STATUS_TINT, STATUSES, statusLabel } from "./meta";

/* View model shared by the list and the board: tabs, filters, display options, grouping. */

export type TicketRow = {
  id: string;
  projectId: string;
  number: number;
  title: string;
  status: TicketStatus;
  priority: TicketPriority;
  assigneeId: string | null;
  creatorId: string | null;
  createdVia: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  labels: readonly { labelId: string }[];
  sources: readonly { messageId: string }[];
};

export type TabKey = "all" | "active" | "backlog";
const TAB_STATUSES: Record<TabKey, readonly TicketStatus[] | null> = { all: null, active: ACTIVE_STATUSES, backlog: BACKLOG_STATUSES };

export type Filters = { status: TicketStatus[]; priority: TicketPriority[]; assignee: string[]; label: string[] };
export type FilterDim = keyof Filters;
export const EMPTY_FILTERS: Filters = { status: [], priority: [], assignee: [], label: [] };
export const hasFilters = (f: Filters) => f.status.length + f.priority.length + f.assignee.length + f.label.length > 0;

export type GroupBy = "status" | "assignee" | "priority" | "none";
export type SortBy = "priority" | "updated" | "created";
export type Display = { groupBy: GroupBy; sortBy: SortBy; showClosed: boolean };
export const DEFAULT_DISPLAY: Display = { groupBy: "status", sortBy: "priority", showClosed: true };

export function applyFilters<T extends TicketRow>(tickets: readonly T[], tab: TabKey, f: Filters, d: Display): T[] {
  const tabStatuses = TAB_STATUSES[tab];
  return tickets.filter((t) => {
    if (tabStatuses && !tabStatuses.includes(t.status)) return false;
    if (!d.showClosed && isClosedStatus(t.status)) return false;
    if (f.status.length && !f.status.includes(t.status)) return false;
    if (f.priority.length && !f.priority.includes(t.priority)) return false;
    if (f.assignee.length && !f.assignee.includes(t.assigneeId ?? "none")) return false;
    if (f.label.length && !t.labels.some((l) => f.label.includes(l.labelId))) return false;
    return true;
  });
}

export function sortTickets<T extends TicketRow>(list: readonly T[], sortBy: SortBy): T[] {
  const time = (t: T) => (sortBy === "created" ? (t.createdAt ?? 0) : (t.updatedAt ?? 0));
  return [...list].sort((a, b) => (sortBy === "priority" ? priorityRank(a.priority) - priorityRank(b.priority) : 0) || time(b) - time(a));
}

export type Group<T extends TicketRow> = {
  key: string;
  label: string;
  kind: GroupBy;
  status?: TicketStatus;
  priority?: TicketPriority;
  assigneeId?: string | null;
  tint: { dark: string; light: string };
  tickets: T[];
};

export function groupTickets<T extends TicketRow>(
  t: TFunction,
  list: readonly T[],
  d: Display,
  people: readonly { id: string; name: string }[],
  meId: string,
): Group<T>[] {
  const sorted = sortTickets(list, d.sortBy);
  if (d.groupBy === "none") return [{ key: "all", label: t("tickets.allTickets"), kind: "none", tint: STATUS_TINT.todo, tickets: sorted }];
  if (d.groupBy === "status")
    return STATUSES.map((s) => ({
      key: s.key,
      label: statusLabel(t, s.key),
      kind: "status" as const,
      status: s.key,
      tint: STATUS_TINT[s.key],
      tickets: sorted.filter((x) => x.status === s.key),
    })).filter((g) => g.tickets.length);
  if (d.groupBy === "priority")
    return ([1, 2, 3, 4, 0] as TicketPriority[])
      .map((p) => ({
        key: `p${p}`,
        label: priorityLabel(t, p),
        kind: "priority" as const,
        priority: p,
        tint: p === 1 ? STATUS_TINT.triage : STATUS_TINT.backlog,
        tickets: sorted.filter((x) => x.priority === p),
      }))
      .filter((g) => g.tickets.length);
  const groups: Group<T>[] = [...people]
    .sort((a, b) => (a.id === meId ? -1 : b.id === meId ? 1 : a.name.localeCompare(b.name)))
    .map((u) => ({
      key: u.id,
      label: u.id === meId ? t("tickets.me", { name: u.name }) : u.name,
      kind: "assignee" as const,
      assigneeId: u.id,
      tint: STATUS_TINT.todo,
      tickets: sorted.filter((x) => x.assigneeId === u.id),
    }));
  groups.push({
    key: "none",
    label: t("tickets.unassigned"),
    kind: "assignee",
    assigneeId: null,
    tint: STATUS_TINT.backlog,
    tickets: sorted.filter((x) => !x.assigneeId),
  });
  return groups.filter((g) => g.tickets.length);
}

/* View state remembered per project (list/board, filters, display) — per-browser convenience */
const storageKey = (projectId: string) => `tickets-view:${projectId}`;
export type ViewState = { layout: "list" | "board"; display: Display; filters: Filters };
export function loadView(projectId: string): ViewState {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (raw) {
      const v = JSON.parse(raw) as Partial<ViewState>;
      return {
        layout: v.layout === "board" ? "board" : "list",
        display: { ...DEFAULT_DISPLAY, ...v.display },
        filters: { ...EMPTY_FILTERS, ...v.filters },
      };
    }
  } catch {}
  return { layout: "list", display: DEFAULT_DISPLAY, filters: EMPTY_FILTERS };
}
export function saveView(projectId: string, v: ViewState) {
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(v));
  } catch {}
}
