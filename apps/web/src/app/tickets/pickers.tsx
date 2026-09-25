import type { TicketPriority, TicketStatus } from "@feedbacks/schema/enums";
import { Avatar, Icon, LabelDot, type MenuEntry } from "@feedbacks/ui";
import type { TFunction } from "i18next";
import {
  PRIORITIES,
  PRIORITY_SHORTCUT,
  ProjectBadge,
  priorityLabel,
  STATUSES,
  statusLabel,
  TicketPriorityIcon,
  TicketStatusIcon,
} from "./meta";

/* Menu entry builders shared by list rows, board cards, the ticket page and the create dialog. */

export function statusEntries(t: TFunction, current: TicketStatus | undefined, onPick: (s: TicketStatus) => void): MenuEntry[] {
  return STATUSES.map((s) => ({
    id: s.key,
    label: statusLabel(t, s.key),
    icon: <TicketStatusIcon status={s.key} />,
    hint: s.shortcut,
    shortcutKey: s.shortcut,
    checked: current === s.key,
    onSelect: () => onPick(s.key),
  }));
}

export function priorityEntries(t: TFunction, current: TicketPriority | undefined, onPick: (p: TicketPriority) => void): MenuEntry[] {
  return PRIORITIES.map((p) => ({
    id: `p${p}`,
    label: priorityLabel(t, p),
    icon: <TicketPriorityIcon priority={p} />,
    hint: PRIORITY_SHORTCUT[p],
    shortcutKey: PRIORITY_SHORTCUT[p],
    checked: current === p,
    onSelect: () => onPick(p),
  }));
}

type Person = { id: string; name: string; image?: string | null };

export function assigneeEntries(
  t: TFunction,
  people: readonly Person[],
  current: string | null | undefined,
  meId: string,
  onPick: (id: string | null) => void,
): MenuEntry[] {
  const sorted = [...people].sort((a, b) => (a.id === meId ? -1 : b.id === meId ? 1 : a.name.localeCompare(b.name)));
  return [
    { id: "none", label: t("tickets.unassigned"), icon: <Avatar user={null} size={16} />, checked: !current, onSelect: () => onPick(null) },
    ...sorted.map((u) => ({
      id: u.id,
      label: u.id === meId ? t("tickets.me", { name: u.name }) : u.name,
      icon: <Avatar user={u} size={16} />,
      checked: current === u.id,
      onSelect: () => onPick(u.id),
    })),
  ];
}

/** Multi-select: use with <Menu keepOpen> */
export function labelEntries(
  labels: readonly { id: string; name: string; color: string }[],
  selected: readonly string[],
  onToggle: (id: string) => void,
): MenuEntry[] {
  return labels.map((l) => ({
    id: l.id,
    label: l.name,
    icon: <LabelDot color={l.color} />,
    checked: selected.includes(l.id),
    onSelect: () => onToggle(l.id),
  }));
}

export function projectEntries(
  projects: readonly { id: string; key: string; name: string; color: string }[],
  current: string | undefined,
  onPick: (id: string) => void,
): MenuEntry[] {
  return projects.map((p) => ({
    id: p.id,
    label: p.name,
    keywords: p.key,
    icon: <ProjectBadge project={p} />,
    hint: <span className="tabular">{p.key}</span>,
    checked: current === p.id,
    onSelect: () => onPick(p.id),
  }));
}

/** Entries that open a sub-action, e.g. "Create label…" at the end of a label menu */
export const actionEntry = (id: string, label: string, onSelect: () => void): MenuEntry => ({
  id,
  label,
  icon: <Icon name="plus" size={14} />,
  onSelect,
});
