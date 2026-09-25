import type { NotificationKind, TicketStatus } from "@feedbacks/schema/enums";
import { ticketKey } from "@feedbacks/schema/tickets";
import { queries } from "@feedbacks/schema/zero";
import { useQuery } from "@rocicorp/zero/react";
import type { TFunction } from "i18next";
import { useOrg } from "../org-context";
import { mentionsToText } from "../search/Highlighted";
import { statusLabel } from "../tickets/meta";

/** Kinds shown in the preferences page, in display order (access requests arrive with the knowledge base) */
export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  "mention",
  "ticket_assigned",
  "ticket_status",
  "comment",
  "ticket_from_my_message",
  "access_request",
];

export function useNotifications(filter: "unread" | "all") {
  const { org } = useOrg();
  const [rows] = useQuery(queries.notifications.list({ organizationId: org.id, filter, limit: 100 }));
  return rows;
}
export type NotificationRow = ReturnType<typeof useNotifications>[number];

export function useNotificationSettings() {
  const { org } = useOrg();
  const [settings] = useQuery(queries.notifications.settings({ organizationId: org.id }));
  return { mutedKinds: (settings?.mutedKinds ?? []) as NotificationKind[], browserEnabled: settings?.browserEnabled ?? false };
}

/** What a notification is about, for display: key or #channel, title, action phrase and excerpt */
export function describe(n: NotificationRow, t: TFunction, nameOf: (userId: string) => string | undefined) {
  const key = n.ticket?.project ? ticketKey(n.ticket.project.key, n.ticket.number) : null;
  const where = key ?? (n.channel && n.channel.kind !== "dm" ? `#${n.channel.name}` : null);
  const title = n.ticket?.title ?? (n.channel ? (n.channel.kind === "dm" ? t("notifications.directMessage") : n.channel.name) : "");
  // Server bodies: "KEY · excerpt" (comments, ticket mentions), "KEY title → status" (status), excerpt (channel mentions)
  const body = n.body ?? "";
  let excerpt = body;
  let phrase = t(`notifications.phrase.${n.kind}`);
  if (n.kind === "ticket_status") {
    const status = body.split("→ ").pop()?.trim() as TicketStatus | undefined;
    phrase = t("notifications.phrase.ticket_status", { status: status ? statusLabel(t, status) : "" });
    excerpt = "";
  } else if (n.kind === "ticket_assigned" || n.kind === "ticket_from_my_message") {
    excerpt = "";
  } else if (key && excerpt.startsWith(`${key} · `)) {
    excerpt = excerpt.slice(key.length + 3);
  }
  return { key: where, title, phrase, excerpt: mentionsToText(excerpt, nameOf) };
}
