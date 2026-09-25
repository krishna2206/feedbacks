import { mutators } from "@feedbacks/schema/zero";
import { Avatar, Button, Icon, Popover, Tooltip, timeAgo, useMenu } from "@feedbacks/ui";
import { useZero } from "@rocicorp/zero/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useGo } from "../go";
import { useOrg } from "../org-context";
import { useOrgMembers } from "../org-data";
import { TicketStatusIcon } from "../tickets/meta";
import { describe, type NotificationRow, useNotifications } from "./data";
import "./notifications.css";

/**
 * Bell + panel. Product rule: no Inbox page. A conversation lives in the chat (unread badges),
 * an event lives here: mentions in channels, ticket assignments and status changes, comments on
 * followed tickets, "your message became a ticket". Direct messages never notify.
 */
export function NotificationsBell() {
  const { t } = useTranslation();
  const panel = useMenu();
  const unread = useNotifications("unread");
  const count = unread.length;
  return (
    <>
      <Tooltip content={t("notifications.title")} placement="bottom" disabled={panel.open}>
        <span className="notif-bell">
          <Button
            variant="muted"
            size="md"
            iconOnly
            icon={<Icon name="bell" />}
            active={panel.open}
            onClick={panel.toggleFrom}
            aria-label={count ? t("notifications.titleUnread", { count }) : t("notifications.title")}
          />
          {count > 0 && (
            <span className="notif-bell__badge" key={count}>
              {count > 9 ? "9+" : count}
            </span>
          )}
        </span>
      </Tooltip>
      <Popover anchor={panel.anchor} onClose={panel.close} width={380}>
        <NotificationPanel unreadCount={count} onClose={panel.close} />
      </Popover>
    </>
  );
}

function NotificationPanel({ unreadCount, onClose }: { unreadCount: number; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const zero = useZero();
  const go = useGo();
  const [tab, setTab] = useState<"unread" | "all">(unreadCount ? "unread" : "all");
  const rows = useNotifications(tab);

  return (
    <div className="notif-panel">
      <div className="notif-panel__head">
        <span className="notif-panel__title">{t("notifications.title")}</span>
        {unreadCount > 0 && <span className="notif-panel__count">{t("notifications.unreadCount", { count: unreadCount })}</span>}
        <span className="spacer" />
        <Button
          variant="muted"
          size="sm"
          disabled={!unreadCount}
          onClick={() => zero.mutate(mutators.notifications.markAllRead({ organizationId: org.id, at: Date.now() }))}
        >
          {t("notifications.markAllRead")}
        </Button>
      </div>
      <div className="notif-panel__tabs" role="tablist">
        {(["unread", "all"] as const).map((k) => (
          <Button key={k} variant="tab" size="sm" active={tab === k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {t(`notifications.tabs.${k}`)}
          </Button>
        ))}
      </div>
      <div className="notif-panel__list">
        {rows.length === 0 ? (
          <div className="notif-empty">
            <Icon name="bell" size={20} />
            <span>{tab === "unread" ? t("notifications.emptyUnread") : t("notifications.empty")}</span>
          </div>
        ) : (
          rows.map((n) => (
            <NotificationItem
              key={n.id}
              n={n}
              onOpen={() => {
                if (!n.readAt) zero.mutate(mutators.notifications.setRead({ ids: [n.id], read: true, at: Date.now() }));
                onClose();
                if (n.ticketId) void go.ticket(n.ticket?.project ? `${n.ticket.project.key}-${n.ticket.number}` : n.ticketId);
                else if (n.channelId) void go.channel(n.channelId, n.messageId ?? undefined, n.message?.parentId ?? null);
              }}
            />
          ))
        )}
      </div>
      <div className="notif-panel__foot">
        <button
          type="button"
          className="notif-panel__link"
          onClick={() => {
            onClose();
            void go.settings("notifications");
          }}
        >
          <Icon name="settings" size={14} />
          {t("notifications.settingsLink")}
        </button>
      </div>
    </div>
  );
}

function NotificationItem({ n, onOpen }: { n: NotificationRow; onOpen: () => void }) {
  const { t, i18n } = useTranslation();
  const zero = useZero();
  const { users } = useOrgMembers();
  const d = describe(n, t, (id) => users.get(id)?.name);
  const setRead = (read: boolean) => zero.mutate(mutators.notifications.setRead({ ids: [n.id], read, at: Date.now() }));
  return (
    // biome-ignore lint/a11y/useSemanticElements: the row contains its own action buttons
    <div
      className="notif-row"
      data-read={!!n.readAt}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
      }}
    >
      <span className="notif-row__avatar">
        <Avatar user={n.actor ?? null} size={24} />
      </span>
      <div className="notif-row__content">
        <div className="notif-row__title">
          {!n.readAt && <span className="notif-dot" />}
          {d.key && <span className="notif-row__key">{d.key}</span>}
          <span className="notif-row__name truncate">{d.title}</span>
          {n.ticket && (
            <span className="notif-row__icon">
              <TicketStatusIcon status={n.ticket.status} size={14} />
            </span>
          )}
        </div>
        <div className="notif-row__sub">
          <span className="truncate">
            <b>{n.actor?.name ?? t("notifications.someone")}</b> {d.phrase}
            {d.excerpt ? ` : ${d.excerpt}` : ""}
          </span>
          <span className="notif-row__age">{timeAgo(n.createdAt ?? Date.now(), i18n.language)}</span>
        </div>
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stops row activation from the action buttons */}
      <span className="notif-row__actions" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <Tooltip content={n.readAt ? t("notifications.markUnread") : t("notifications.markRead")} placement="top">
          <Button
            variant="muted"
            size="sm"
            iconOnly
            icon={<Icon name={n.readAt ? "mailUnread" : "mailRead"} size={14} />}
            onClick={() => setRead(!n.readAt)}
            aria-label={n.readAt ? t("notifications.markUnread") : t("notifications.markRead")}
          />
        </Tooltip>
        <Tooltip content={t("notifications.archive")} placement="top">
          <Button
            variant="muted"
            size="sm"
            iconOnly
            icon={<Icon name="archive" size={14} />}
            onClick={() => zero.mutate(mutators.notifications.archive({ ids: [n.id], at: Date.now() }))}
            aria-label={t("notifications.archive")}
          />
        </Tooltip>
      </span>
    </div>
  );
}
