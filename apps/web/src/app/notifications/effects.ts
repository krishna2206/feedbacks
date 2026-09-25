import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useGo } from "../go";
import { useOrgMembers } from "../org-data";
import { describe, useNotificationSettings, useNotifications } from "./data";

const BASE_TITLE = "Feedbacks";

/**
 * Side effects of unread notifications, mounted once in the app shell:
 * - the tab title shows the count: "(3) Feedbacks";
 * - opt-in browser notifications (preferences) for notifications that arrive while the tab
 *   doesn't have the focus.
 */
export function useNotificationEffects() {
  const { t } = useTranslation();
  const go = useGo();
  const { users } = useOrgMembers();
  const unread = useNotifications("unread");
  const { browserEnabled } = useNotificationSettings();

  useEffect(() => {
    document.title = unread.length ? `(${unread.length > 99 ? "99+" : unread.length}) ${BASE_TITLE}` : BASE_TITLE;
    return () => {
      document.title = BASE_TITLE;
    };
  }, [unread.length]);

  // Only notifications created after the app started: never replay the backlog
  const startedAt = useRef(Date.now());
  const shown = useRef(new Set<string>());
  useEffect(() => {
    if (!browserEnabled || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    for (const n of unread) {
      if ((n.createdAt ?? 0) < startedAt.current || shown.current.has(n.id)) continue;
      shown.current.add(n.id);
      if (document.hasFocus()) continue;
      const d = describe(n, t, (id) => users.get(id)?.name);
      const note = new Notification(`${n.actor?.name ?? ""} ${d.phrase}`.trim(), {
        body: [d.key, d.title, d.excerpt].filter(Boolean).join(" · "),
        tag: n.id,
      });
      note.onclick = () => {
        window.focus();
        note.close();
        if (n.ticketId) void go.ticket(n.ticket?.project ? `${n.ticket.project.key}-${n.ticket.number}` : n.ticketId);
        else if (n.channelId) void go.channel(n.channelId, n.messageId ?? undefined, n.message?.parentId ?? null);
        else if (n.docId) void go.doc(n.docId);
        else if (n.folderId) void go.docs(n.folderId);
      };
    }
  }, [unread, browserEnabled, t, users, go]);
}
