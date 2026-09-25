import type { TicketPriority, TicketStatus } from "@feedbacks/schema/enums";
import { PriorityIcon, StatusIcon, type StatusType } from "@feedbacks/ui";
import type { TFunction } from "i18next";

/* Display metadata of statuses and priorities (labels come from i18n: tickets.status.* / tickets.priority.*). */

export type StatusMeta = { key: TicketStatus; type: StatusType; progress: number; color: string; shortcut: string };

export const STATUSES: readonly StatusMeta[] = [
  { key: "triage", type: "triage", progress: 0, color: "var(--status-triage)", shortcut: "1" },
  { key: "backlog", type: "backlog", progress: 0, color: "var(--status-backlog)", shortcut: "2" },
  { key: "todo", type: "unstarted", progress: 0, color: "var(--status-todo)", shortcut: "3" },
  { key: "in_progress", type: "started", progress: 0.5, color: "var(--status-in-progress)", shortcut: "4" },
  { key: "in_review", type: "started", progress: 0.75, color: "var(--status-in-review)", shortcut: "5" },
  { key: "done", type: "completed", progress: 1, color: "var(--status-done)", shortcut: "6" },
  { key: "canceled", type: "canceled", progress: 1, color: "var(--status-canceled)", shortcut: "7" },
];
export const statusMeta = (s: TicketStatus) => STATUSES.find((m) => m.key === s) ?? (STATUSES[2] as StatusMeta);

/** Group header tint (subtle hue of the status) */
export const STATUS_TINT: Record<TicketStatus, { dark: string; light: string }> = {
  triage: { dark: "#201a1b", light: "#f6ecec" },
  backlog: { dark: "#1c1c1e", light: "#ececf2" },
  todo: { dark: "#1c1c1d", light: "#ececf0" },
  in_progress: { dark: "#1d1b1a", light: "#f4ece6" },
  in_review: { dark: "#181d1b", light: "#e8f3ec" },
  done: { dark: "#1b1b24", light: "#ebebf5" },
  canceled: { dark: "#1c1c1d", light: "#ededee" },
};

/** Menu order: urgent → low, then none */
export const PRIORITIES: readonly TicketPriority[] = [0, 1, 2, 3, 4];
export const PRIORITY_SHORTCUT: Record<TicketPriority, string> = { 0: "0", 1: "1", 2: "2", 3: "3", 4: "4" };
/** Sort rank: urgent first, "no priority" last */
export const priorityRank = (p: TicketPriority) => (p === 0 ? 5 : p);

export const statusLabel = (t: TFunction, s: TicketStatus) => t(`tickets.status.${s}`);
export const priorityLabel = (t: TFunction, p: TicketPriority) => t(`tickets.priority.${p}`);

export function TicketStatusIcon({ status, size = 14, label }: { status: TicketStatus; size?: number; label?: string }) {
  const m = statusMeta(status);
  return <StatusIcon type={m.type} progress={m.progress} color={m.color} size={size} label={label} />;
}

export function TicketPriorityIcon({ priority, size = 16, label }: { priority: TicketPriority; size?: number; label?: string }) {
  return <PriorityIcon priority={priority} size={size} label={label} />;
}

/** Small colored square with the project's first letter */
export function ProjectBadge({ project, size = 16 }: { project?: { name: string; color: string } | null; size?: number }) {
  return (
    <span
      className="project-badge"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.56), background: project?.color ?? "var(--bg-border-solid)" }}
      aria-hidden
    >
      {project?.name[0]?.toUpperCase() ?? "?"}
    </span>
  );
}

export const PROJECT_COLORS = ["#5e6ad2", "#26b5ce", "#4cb782", "#f2c94c", "#f2994a", "#eb5757", "#bb87fc", "#95a2b3"] as const;
export const LABEL_COLORS = ["#eb5757", "#f2994a", "#f2c94c", "#4cb782", "#26b5ce", "#5e6ad2", "#bb87fc", "#95a2b3"] as const;
