import { Avatar, Button, Caret, Checkbox, Icon, LabelDot, shortDate, Tooltip } from "@feedbacks/ui";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTheme } from "../../lib/theme";
import type { OrgUser } from "../org-data";
import { useTicketMenus } from "./actions";
import { ProjectBadge, TicketPriorityIcon, TicketStatusIcon } from "./meta";
import type { Group, TicketRow } from "./model";

/** Single-key shortcuts are ignored while typing or while an overlay is open */
export function shortcutsBlocked(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return true;
  return !!document.querySelector(".popover, .modal-backdrop");
}

type Props<T extends TicketRow> = {
  groups: Group<T>[];
  keyOf: (t: TicketRow) => string;
  users: Map<string, OrgUser>;
  labels: Map<string, { id: string; name: string; color: string }>;
  /** Assignable people (menus) */
  people: readonly OrgUser[];
  /** Cross-project views: prefix keys with the project badge */
  projects?: Map<string, { name: string; color: string }>;
  onOpen: (t: T) => void;
  onCreateInGroup?: (g: Group<T>) => void;
  canEdit: (t: T) => boolean;
  empty: ReactNode;
};

export function TicketList<T extends TicketRow>({
  groups,
  keyOf,
  users,
  labels,
  people,
  projects,
  onOpen,
  onCreateInGroup,
  canEdit,
  empty,
}: Props<T>) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const [kbdMode, setKbdMode] = useState(false);
  const anchorId = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const all = useMemo(() => new Map(groups.flatMap((g) => g.tickets).map((x) => [x.id, x as TicketRow])), [groups]);
  const menus = useTicketMenus({ tickets: all, people, keyOf });
  const flat = useMemo(() => groups.flatMap((g) => (collapsed.has(g.key) ? [] : g.tickets)), [groups, collapsed]);
  const flatIds = useMemo(() => flat.map((x) => x.id), [flat]);

  // Drop selected rows that disappeared (filters, moves)
  useEffect(() => {
    setSelection((sel) => {
      const next = new Set([...sel].filter((id) => flatIds.includes(id)));
      return next.size === sel.size ? sel : next;
    });
  }, [flatIds]);

  const editable = useCallback(
    (ids: string[]) =>
      ids.filter((id) => {
        const x = all.get(id) as T | undefined;
        return x && canEdit(x);
      }),
    [all, canEdit],
  );
  const targets = useCallback(
    (id: string) => editable(selection.has(id) && selection.size > 1 ? [...selection] : [id]),
    [selection, editable],
  );

  const openRowMenu = useCallback(
    (kind: "status" | "priority" | "assignee" | "labels", id: string) => {
      const ids = targets(id);
      if (!ids.length) return;
      const el =
        listRef.current?.querySelector<HTMLElement>(`[data-row-id="${id}"] [data-role="${kind}"]`) ??
        listRef.current?.querySelector<HTMLElement>(`[data-row-id="${id}"]`);
      if (el) menus.open(kind, el, ids);
    },
    [menus, targets],
  );

  const toggleSel = useCallback((id: string) => {
    setSelection((sel) => {
      const next = new Set(sel);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onRowClick = (e: React.MouseEvent, x: T) => {
    if (e.shiftKey && anchorId.current) {
      const a = flatIds.indexOf(anchorId.current);
      const b = flatIds.indexOf(x.id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelection((sel) => new Set([...sel, ...flatIds.slice(lo, hi + 1)]));
        return;
      }
    }
    anchorId.current = x.id;
    if (e.metaKey || e.ctrlKey) {
      toggleSel(x.id);
      return;
    }
    onOpen(x);
  };

  // Keyboard: ↑/↓ j/k, Enter, x, s/p/a/l, Esc
  const live = useRef({ flatIds, cursor, selection, all, onOpen });
  live.current = { flatIds, cursor, selection, all, onOpen };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || shortcutsBlocked(e)) return;
      const { flatIds: ids, cursor: cur, selection: sel } = live.current;
      if (!ids.length) return;
      const i = cur ? ids.indexOf(cur) : -1;
      const move = (d: number) => {
        e.preventDefault();
        const next = ids[i < 0 ? (d > 0 ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, i + d))] as string;
        setCursor(next);
        setKbdMode(true);
        if (e.shiftKey) setSelection((s) => new Set([...s, ...(cur ? [cur] : []), next]));
        listRef.current?.querySelector(`[data-row-id="${next}"]`)?.scrollIntoView({ block: "nearest" });
      };
      switch (e.key) {
        case "ArrowDown":
        case "j":
          move(1);
          break;
        case "ArrowUp":
        case "k":
          move(-1);
          break;
        case "Enter": {
          const x = cur ? (live.current.all.get(cur) as T | undefined) : undefined;
          if (x) {
            e.preventDefault();
            live.current.onOpen(x);
          }
          break;
        }
        case "x":
          if (cur) {
            e.preventDefault();
            toggleSel(cur);
            anchorId.current = cur;
          }
          break;
        case "s":
        case "p":
        case "a":
        case "l": {
          const id = cur ?? (sel.size ? [...sel][0] : null);
          if (!id) return;
          e.preventDefault();
          openRowMenu(e.key === "s" ? "status" : e.key === "p" ? "priority" : e.key === "a" ? "assignee" : "labels", id);
          break;
        }
        case "Escape":
          if (sel.size) {
            e.preventDefault();
            setSelection(new Set());
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openRowMenu, toggleSel]);

  if (!groups.length) return <>{empty}</>;
  const hasSel = selection.size > 0;
  const selIds = editable([...selection]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: leaving keyboard mode on mouse move
    <div className="iss-scroll" onMouseMove={() => kbdMode && setKbdMode(false)}>
      <div className="iss-list" ref={listRef} data-has-selection={hasSel}>
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.key);
          return (
            <div key={g.key} className="iss-group">
              <div className="iss-group-h" data-surface="elevated" style={{ ["--grp-tint" as string]: g.tint[theme] }}>
                <button
                  type="button"
                  className="iss-group-h__toggle"
                  data-open={!isCollapsed}
                  aria-label={isCollapsed ? t("tickets.expandGroup") : t("tickets.collapseGroup")}
                  onClick={() =>
                    setCollapsed((c) => {
                      const n = new Set(c);
                      if (n.has(g.key)) n.delete(g.key);
                      else n.add(g.key);
                      return n;
                    })
                  }
                >
                  <Caret />
                </button>
                {g.kind === "status" && g.status ? (
                  <TicketStatusIcon status={g.status} />
                ) : g.kind === "priority" && g.priority !== undefined ? (
                  <TicketPriorityIcon priority={g.priority} />
                ) : g.kind === "assignee" ? (
                  <Avatar user={g.assigneeId ? (users.get(g.assigneeId) ?? null) : null} size={16} />
                ) : null}
                <span className="iss-group-h__title">{g.label}</span>
                <span className="iss-group-h__count tabular">{g.tickets.length}</span>
                <span className="spacer" />
                {onCreateInGroup && (
                  <Tooltip content={t("tickets.newInGroup")} placement="top">
                    <Button
                      className="iss-group-h__add"
                      variant="muted"
                      size="sm"
                      iconOnly
                      icon={<Icon name="plus" size={14} />}
                      onClick={() => onCreateInGroup(g)}
                      aria-label={t("tickets.newInGroup")}
                    />
                  </Tooltip>
                )}
              </div>
              {!isCollapsed &&
                g.tickets.map((x, i) => {
                  const selected = selection.has(x.id);
                  return (
                    <Row
                      key={x.id}
                      x={x}
                      tkey={keyOf(x)}
                      project={projects?.get(x.projectId)}
                      assignee={x.assigneeId ? users.get(x.assigneeId) : undefined}
                      labels={labels}
                      locale={i18n.language}
                      editable={canEdit(x)}
                      selected={selected}
                      selPrev={selected && i > 0 && selection.has(g.tickets[i - 1]?.id ?? "")}
                      selNext={selected && i < g.tickets.length - 1 && selection.has(g.tickets[i + 1]?.id ?? "")}
                      cursor={cursor === x.id}
                      kbd={kbdMode && cursor === x.id}
                      onHover={setCursor}
                      onClick={(e) => onRowClick(e, x)}
                      onToggle={() => {
                        toggleSel(x.id);
                        anchorId.current = x.id;
                      }}
                      onMenu={(kind, el) => {
                        const ids = targets(x.id);
                        if (ids.length) menus.open(kind, el, ids);
                      }}
                    />
                  );
                })}
            </div>
          );
        })}
        <div style={{ height: 80 }} />
      </div>
      {hasSel && (
        <div className="iss-selbar" data-surface="elevated" role="toolbar" aria-label={t("tickets.selectionActions")}>
          <span className="iss-selbar__count tabular">{t("tickets.selected", { count: selection.size })}</span>
          {selIds.length > 0 && (
            <>
              <Button
                size="md"
                variant="secondary"
                icon={<TicketStatusIcon status="in_progress" />}
                onClick={(e) => menus.open("status", e.currentTarget, selIds)}
              >
                {t("tickets.status.label")}
              </Button>
              <Button
                size="md"
                variant="secondary"
                icon={<TicketPriorityIcon priority={2} size={14} />}
                onClick={(e) => menus.open("priority", e.currentTarget, selIds)}
              >
                {t("tickets.priorityLabel")}
              </Button>
              <Button
                size="md"
                variant="secondary"
                icon={<Icon name="user" size={14} />}
                onClick={(e) => menus.open("assignee", e.currentTarget, selIds)}
              >
                {t("tickets.assignee")}
              </Button>
              <Button
                size="md"
                variant="secondary"
                icon={<Icon name="tag" size={14} />}
                onClick={(e) => menus.open("labels", e.currentTarget, selIds)}
              >
                {t("tickets.labels")}
              </Button>
            </>
          )}
          <Tooltip content={t("tickets.clearSelection")} shortcut="Esc">
            <Button
              size="md"
              variant="muted"
              iconOnly
              icon={<Icon name="x" size={14} />}
              onClick={() => setSelection(new Set())}
              aria-label={t("tickets.clearSelection")}
            />
          </Tooltip>
        </div>
      )}
      {menus.element}
    </div>
  );
}

type RowProps = {
  x: TicketRow;
  tkey: string;
  project?: { name: string; color: string };
  assignee?: OrgUser;
  labels: Map<string, { id: string; name: string; color: string }>;
  locale: string;
  editable: boolean;
  selected: boolean;
  selPrev: boolean;
  selNext: boolean;
  cursor: boolean;
  kbd: boolean;
  onHover: (id: string) => void;
  onClick: (e: React.MouseEvent) => void;
  onToggle: () => void;
  onMenu: (kind: "status" | "priority" | "assignee" | "labels" | "context", anchor: HTMLElement | { x: number; y: number }) => void;
};

const Row = memo(function Row({
  x,
  tkey,
  project,
  assignee,
  labels,
  locale,
  editable,
  selected,
  selPrev,
  selNext,
  cursor,
  kbd,
  onHover,
  onClick,
  onToggle,
  onMenu,
}: RowProps) {
  const { t } = useTranslation();
  const rowLabels = x.labels.map((l) => labels.get(l.labelId)).filter((l): l is { id: string; name: string; color: string } => !!l);
  const menuBtn = (kind: "status" | "priority" | "assignee") => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (editable) onMenu(kind, e.currentTarget as HTMLElement);
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: keyboard users drive the list with ↑↓/j/k, Enter, x (see TicketList)
    <div
      className="iss-row"
      data-row-id={x.id}
      data-surface={selected ? "selected" : undefined}
      data-selected={selected}
      data-sel-prev={selPrev}
      data-sel-next={selNext}
      data-cursor={cursor}
      data-kbd={kbd}
      onMouseEnter={() => onHover(x.id)}
      onClick={onClick}
      onContextMenu={(e) => {
        if (!editable) return;
        e.preventDefault();
        onMenu("context", { x: e.clientX, y: e.clientY });
      }}
    >
      <span />
      <span className="iss-row__cbx">
        <Checkbox checked={selected} onChange={onToggle} label={t("tickets.select", { key: tkey })} />
      </span>
      <button
        type="button"
        className="iss-icon-btn"
        data-role="priority"
        disabled={!editable}
        onClick={menuBtn("priority")}
        aria-label={t("tickets.priorityLabel")}
      >
        <TicketPriorityIcon priority={x.priority} />
      </button>
      <span className="iss-row__id tabular">
        {project && <ProjectBadge project={project} size={14} />}
        {tkey}
      </span>
      <button
        type="button"
        className="iss-icon-btn"
        data-role="status"
        disabled={!editable}
        onClick={menuBtn("status")}
        aria-label={t("tickets.status.label")}
      >
        <TicketStatusIcon status={x.status} />
      </button>
      <span className="iss-row__main">
        <span className="iss-row__title">{x.title}</span>
        <span className="iss-row__badges">
          {x.sources.length > 0 && (
            <Tooltip content={t("tickets.sourceCount", { count: x.sources.length })}>
              <span className="iss-src">
                <Icon name="chat" size={14} />
                {x.sources.length}
              </span>
            </Tooltip>
          )}
          {(x.createdVia === "mcp" || x.createdVia === "api") && (
            <Tooltip content={t(x.createdVia === "mcp" ? "tickets.viaMcp" : "tickets.viaApi")}>
              <span className="iss-src">
                <Icon name="bot" size={14} />
              </span>
            </Tooltip>
          )}
          {rowLabels.map((l) => (
            <span key={l.id} className="chip iss-chip">
              <LabelDot color={l.color} />
              <span className="truncate">{l.name}</span>
            </span>
          ))}
          <button
            type="button"
            className="iss-avatar-btn"
            data-role="assignee"
            disabled={!editable}
            onClick={menuBtn("assignee")}
            aria-label={t("tickets.assignee")}
          >
            <Avatar user={assignee ?? null} size={18} />
          </button>
        </span>
      </span>
      <span className="iss-row__date">{x.updatedAt ? shortDate(x.updatedAt, locale) : ""}</span>
      <span />
    </div>
  );
});
