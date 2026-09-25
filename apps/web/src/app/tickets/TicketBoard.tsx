import type { TicketStatus } from "@feedbacks/schema/enums";
import { ACTIVE_STATUSES, BACKLOG_STATUSES } from "@feedbacks/schema/tickets";
import { Avatar, Button, Icon, LabelDot, Tooltip } from "@feedbacks/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OrgUser } from "../org-data";
import { useTicketActions, useTicketMenus } from "./actions";
import { ProjectBadge, STATUSES, statusLabel, TicketPriorityIcon, TicketStatusIcon } from "./meta";
import { type Display, sortTickets, type TabKey, type TicketRow } from "./model";

type Props<T extends TicketRow> = {
  tickets: readonly T[];
  display: Display;
  tab: TabKey;
  keyOf: (t: TicketRow) => string;
  users: Map<string, OrgUser>;
  labels: Map<string, { id: string; name: string; color: string }>;
  people: readonly OrgUser[];
  projects?: Map<string, { name: string; color: string }>;
  canEdit: (t: T) => boolean;
  onOpen: (t: T) => void;
  onCreate?: (status: TicketStatus) => void;
};

/** Status columns, native drag and drop between them (drop = status change) */
export function TicketBoard<T extends TicketRow>({
  tickets,
  display,
  tab,
  keyOf,
  users,
  labels,
  people,
  projects,
  canEdit,
  onOpen,
  onCreate,
}: Props<T>) {
  const { t } = useTranslation();
  const actions = useTicketActions();
  const all = useMemo(() => new Map(tickets.map((x) => [x.id, x as TicketRow])), [tickets]);
  const menus = useTicketMenus({ tickets: all, people, keyOf });
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<TicketStatus | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  const tabStatuses = tab === "active" ? ACTIVE_STATUSES : tab === "backlog" ? BACKLOG_STATUSES : null;
  // "Canceled" is hidden unless the tab/filter explicitly contains canceled tickets
  const cols = STATUSES.filter(
    (s) =>
      (!tabStatuses || tabStatuses.includes(s.key)) &&
      (display.showClosed || (s.key !== "done" && s.key !== "canceled")) &&
      (s.key !== "canceled" || tickets.some((x) => x.status === "canceled")),
  );
  const sorted = sortTickets(tickets, display.sortBy);

  const drop = (status: TicketStatus) => {
    const id = dragId;
    setOverCol(null);
    setDragId(null);
    if (!id) return;
    const x = all.get(id) as T | undefined;
    if (!x || x.status === status || !canEdit(x)) return;
    actions.update([id], { status });
    setFlash(id);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 1600);
  };

  return (
    <div className="iss-board">
      {cols.map((c) => {
        const items = sorted.filter((x) => x.status === c.key);
        return (
          <section
            key={c.key}
            className="iss-col"
            aria-label={statusLabel(t, c.key)}
            data-over={overCol === c.key && !!dragId}
            onDragOver={(e) => {
              if (!dragId) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (overCol !== c.key) setOverCol(c.key);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverCol((o) => (o === c.key ? null : o));
            }}
            onDrop={(e) => {
              e.preventDefault();
              drop(c.key);
            }}
          >
            <div className="iss-col__bg" />
            <header className="iss-col__h">
              <TicketStatusIcon status={c.key} />
              <span className="iss-col__name">{statusLabel(t, c.key)}</span>
              <span className="iss-col__count tabular">{items.length}</span>
              <span className="spacer" />
              {onCreate && (
                <span className="iss-col__actions">
                  <Tooltip content={t("tickets.newTicket")} placement="top">
                    <Button
                      variant="muted"
                      size="sm"
                      iconOnly
                      icon={<Icon name="plus" size={14} />}
                      onClick={() => onCreate(c.key)}
                      aria-label={t("tickets.newTicket")}
                    />
                  </Tooltip>
                </span>
              )}
            </header>
            <div className="iss-col__cards">
              {items.map((x) => {
                const editable = canEdit(x);
                const cardLabels = x.labels
                  .map((l) => labels.get(l.labelId))
                  .filter((l): l is { id: string; name: string; color: string } => !!l);
                return (
                  <article
                    key={x.id}
                    className="iss-card"
                    draggable={editable}
                    data-dragging={dragId === x.id}
                    data-flash={flash === x.id}
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: cards open with Enter
                    tabIndex={0}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", x.id);
                      setDragId(x.id);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setOverCol(null);
                    }}
                    onClick={() => onOpen(x)}
                    onKeyDown={(e) => e.key === "Enter" && onOpen(x)}
                    onContextMenu={(e) => {
                      if (!editable) return;
                      e.preventDefault();
                      menus.open("context", { x: e.clientX, y: e.clientY }, [x.id]);
                    }}
                  >
                    <div className="iss-card__id tabular">
                      {projects?.get(x.projectId) && <ProjectBadge project={projects.get(x.projectId)} size={12} />}
                      {keyOf(x)}
                    </div>
                    <div className="iss-card__title">
                      <span className="iss-card__status">
                        <TicketStatusIcon status={x.status} />
                      </span>
                      <span className="iss-card__text">{x.title}</span>
                    </div>
                    <span className="iss-card__avatar">
                      <Avatar user={x.assigneeId ? (users.get(x.assigneeId) ?? null) : null} size={18} />
                    </span>
                    <div className="iss-card__chips">
                      <button
                        type="button"
                        className="chip chip--square chip--icon"
                        disabled={!editable}
                        onClick={(e) => {
                          e.stopPropagation();
                          menus.open("priority", e.currentTarget, [x.id]);
                        }}
                        aria-label={t("tickets.priorityLabel")}
                      >
                        <TicketPriorityIcon priority={x.priority} size={14} />
                      </button>
                      {x.sources.length > 0 && (
                        <Tooltip content={t("tickets.sourceCount", { count: x.sources.length })}>
                          <span className="chip chip--square">
                            <Icon name="chat" size={14} />
                            {x.sources.length}
                          </span>
                        </Tooltip>
                      )}
                      {(x.createdVia === "mcp" || x.createdVia === "api") && (
                        <Tooltip content={t(x.createdVia === "mcp" ? "tickets.viaMcp" : "tickets.viaApi")}>
                          <span className="chip chip--square chip--icon">
                            <Icon name="bot" size={14} />
                          </span>
                        </Tooltip>
                      )}
                      {cardLabels.map((l) => (
                        <span key={l.id} className="chip chip--square">
                          <LabelDot color={l.color} tiny />
                          <span className="truncate">{l.name}</span>
                        </span>
                      ))}
                    </div>
                  </article>
                );
              })}
              {!items.length && onCreate && (
                <button type="button" className="iss-col__empty" onClick={() => onCreate(c.key)}>
                  <Icon name="plus" size={14} />
                  {t("tickets.addTicket")}
                </button>
              )}
            </div>
          </section>
        );
      })}
      {menus.element}
    </div>
  );
}
