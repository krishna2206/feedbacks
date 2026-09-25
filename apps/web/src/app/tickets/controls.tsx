import type { TicketPriority, TicketStatus } from "@feedbacks/schema/enums";
import { type Anchor, Avatar, Button, Caret, Icon, LabelDot, Menu, type MenuEntry, Popover, Tooltip, useMenu } from "@feedbacks/ui";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OrgUser } from "../org-data";
import { PRIORITIES, priorityLabel, STATUSES, statusLabel, TicketPriorityIcon, TicketStatusIcon } from "./meta";
import { type Display, EMPTY_FILTERS, type FilterDim, type Filters, type GroupBy, hasFilters, type SortBy } from "./model";

const DIMS: FilterDim[] = ["status", "priority", "assignee", "label"];
const DIM_ICON: Record<FilterDim, ReactNode> = {
  status: <TicketStatusIcon status="in_progress" />,
  priority: <TicketPriorityIcon priority={2} />,
  assignee: <Icon name="user" />,
  label: <Icon name="tag" />,
};
const toggle = <T,>(arr: readonly T[], v: T): T[] => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

type Common = {
  filters: Filters;
  onChange: (f: Filters) => void;
  people: readonly OrgUser[];
  labels: readonly { id: string; name: string; color: string }[];
  meId: string;
};

/** "Filter" button: pick a dimension, then toggle values (multi-select) */
export function FilterButton({ filters, onChange, people, labels, meId }: Common) {
  const { t } = useTranslation();
  const root = useMenu();
  const [dim, setDim] = useState<{ d: FilterDim; anchor: Anchor } | null>(null);
  const dimLabel = (d: FilterDim) => t(`tickets.filter.${d}`);

  const dimItems: MenuEntry[] = DIMS.map((d) => ({
    id: d,
    label: dimLabel(d),
    icon: DIM_ICON[d],
    hint: filters[d].length ? String(filters[d].length) : undefined,
    onSelect: () => {
      const a = root.anchor;
      if (a) setTimeout(() => setDim({ d, anchor: a }), 0);
    },
  }));

  const valueItems = (d: FilterDim): MenuEntry[] => {
    const set = <K extends FilterDim>(k: K, v: Filters[K][number]) => onChange({ ...filters, [k]: toggle(filters[k] as unknown[], v) });
    if (d === "status")
      return STATUSES.map((s) => ({
        id: s.key,
        label: statusLabel(t, s.key),
        icon: <TicketStatusIcon status={s.key} />,
        checked: filters.status.includes(s.key),
        onSelect: () => set("status", s.key),
      }));
    if (d === "priority")
      return PRIORITIES.map((p) => ({
        id: `p${p}`,
        label: priorityLabel(t, p),
        icon: <TicketPriorityIcon priority={p} />,
        checked: filters.priority.includes(p),
        onSelect: () => set("priority", p),
      }));
    if (d === "assignee")
      return [
        {
          id: "none",
          label: t("tickets.unassigned"),
          icon: <Avatar user={null} size={16} />,
          checked: filters.assignee.includes("none"),
          onSelect: () => set("assignee", "none"),
        },
        ...people.map((u) => ({
          id: u.id,
          label: u.id === meId ? t("tickets.me", { name: u.name }) : u.name,
          icon: <Avatar user={u} size={16} />,
          checked: filters.assignee.includes(u.id),
          onSelect: () => set("assignee", u.id),
        })),
      ];
    return labels.map((l) => ({
      id: l.id,
      label: l.name,
      icon: <LabelDot color={l.color} />,
      checked: filters.label.includes(l.id),
      onSelect: () => set("label", l.id),
    }));
  };

  return (
    <>
      <Tooltip content={t("tickets.filterTickets")} placement="bottom">
        <Button
          variant="borderless"
          size="sm"
          icon={<Icon name="filter" size={14} />}
          active={root.open || !!dim}
          onClick={(e) => (dim ? setDim(null) : root.toggleFrom(e))}
        >
          {t("tickets.filterButton")}
        </Button>
      </Tooltip>
      <Menu anchor={root.anchor} onClose={root.close} items={dimItems} filterPlaceholder={t("tickets.filterBy")} width={220} />
      {dim && (
        <Menu
          anchor={dim.anchor}
          onClose={() => setDim(null)}
          items={valueItems(dim.d)}
          keepOpen
          filterPlaceholder={`${dimLabel(dim.d)}…`}
          width={240}
        />
      )}
    </>
  );
}

/** 44px sub-header listing active filters as removable chips */
export function ActiveFilters({ filters, onChange, people, labels }: Common) {
  const { t } = useTranslation();
  if (!hasFilters(filters)) return null;
  const values = (d: FilterDim): string[] => {
    if (d === "status") return (filters.status as TicketStatus[]).map((k) => statusLabel(t, k));
    if (d === "priority") return (filters.priority as TicketPriority[]).map((p) => priorityLabel(t, p));
    if (d === "assignee")
      return filters.assignee.map((a) => (a === "none" ? t("tickets.unassigned") : (people.find((u) => u.id === a)?.name ?? "?")));
    return filters.label.map((l) => labels.find((x) => x.id === l)?.name ?? "?");
  };
  return (
    <div className="iss-filterbar">
      {DIMS.filter((d) => filters[d].length).map((d) => (
        <span key={d} className="iss-fchip">
          <span className="iss-fchip__part iss-fchip__dim">
            {DIM_ICON[d]}
            {t(`tickets.filter.${d}`)}
          </span>
          <span className="iss-fchip__part">{filters[d].length > 1 ? t("tickets.filterIsAnyOf") : t("tickets.filterIs")}</span>
          <span className="iss-fchip__part iss-fchip__val truncate">{values(d).join(", ")}</span>
          <button
            type="button"
            className="iss-fchip__part iss-fchip__x"
            aria-label={t("tickets.removeFilter")}
            onClick={() => onChange({ ...filters, [d]: [] })}
          >
            <Icon name="x" size={12} />
          </button>
        </span>
      ))}
      <Button variant="muted" size="sm" onClick={() => onChange(EMPTY_FILTERS)}>
        {t("tickets.clearFilters")}
      </Button>
    </div>
  );
}

const GROUPS: GroupBy[] = ["status", "assignee", "priority", "none"];
const SORTS: SortBy[] = ["priority", "updated", "created"];

/** "Display" popover: grouping (list), ordering, closed tickets */
export function DisplayButton({ display, onChange, board }: { display: Display; onChange: (d: Display) => void; board?: boolean }) {
  const { t } = useTranslation();
  const pop = useMenu();
  const groupMenu = useMenu();
  const sortMenu = useMenu();
  return (
    <>
      <Button variant="secondary" size="sm" icon={<Icon name="sliders" size={14} />} active={pop.open} onClick={pop.toggleFrom}>
        {t("tickets.display")}
      </Button>
      <Popover
        anchor={pop.anchor}
        onClose={() => {
          if (!groupMenu.open && !sortMenu.open) pop.close();
        }}
        placement="bottom-end"
        width={300}
      >
        <div className="iss-display">
          <div className="iss-display__row">
            <span>{t("tickets.groupBy")}</span>
            <Button variant="secondary" size="sm" disabled={board} onClick={groupMenu.toggleFrom}>
              {t(`tickets.group.${board ? "status" : display.groupBy}`)}
              <Caret />
            </Button>
          </div>
          <div className="iss-display__row">
            <span>{t("tickets.sortBy")}</span>
            <Button variant="secondary" size="sm" onClick={sortMenu.toggleFrom}>
              {t(`tickets.sort.${display.sortBy}`)}
              <Caret />
            </Button>
          </div>
          <div className="iss-display__sep" />
          <div className="iss-display__row">
            <span>{t("tickets.showClosed")}</span>
            <button
              type="button"
              role="switch"
              aria-checked={display.showClosed}
              aria-label={t("tickets.showClosed")}
              className="iss-switch"
              data-on={display.showClosed}
              onClick={() => onChange({ ...display, showClosed: !display.showClosed })}
            />
          </div>
        </div>
      </Popover>
      <Menu
        anchor={groupMenu.anchor}
        onClose={groupMenu.close}
        placement="bottom-end"
        width={200}
        items={GROUPS.map((g) => ({
          id: g,
          label: t(`tickets.group.${g}`),
          checked: display.groupBy === g,
          onSelect: () => onChange({ ...display, groupBy: g }),
        }))}
      />
      <Menu
        anchor={sortMenu.anchor}
        onClose={sortMenu.close}
        placement="bottom-end"
        width={220}
        items={SORTS.map((k) => ({
          id: k,
          label: t(`tickets.sort.${k}`),
          checked: display.sortBy === k,
          onSelect: () => onChange({ ...display, sortBy: k }),
        }))}
      />
    </>
  );
}
