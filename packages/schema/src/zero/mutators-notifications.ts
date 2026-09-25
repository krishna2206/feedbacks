/**
 * Notifications: read state, archiving and per-user preferences.
 *
 * Product rules (see docs/ARCHITECTURE.md):
 * - a conversation lives in the chat, an event lives in the notifications: direct messages never notify;
 * - a muted kind is never created for that user (checked when notifications are written, server-side);
 * - people only act on their own notifications.
 */
import "./context";
import { defineMutator, type Transaction } from "@rocicorp/zero";
import { z } from "zod";
import { type NotificationKind, notificationKind } from "../enums";
import { assertOrgMember, PermissionError } from "./permissions";
import { zql } from "./schema";

const id = z.string().min(1).max(200);
const at = (tx: Transaction, clientTime: number) => (tx.location === "server" ? Date.now() : clientTime);

export const notificationSettingId = (organizationId: string, userId: string) => `${organizationId}:${userId}`;

/** Server-side: whether `userId` wants notifications of `kind` in an organization */
export async function wantsNotification(tx: Transaction, userId: string, organizationId: string, kind: NotificationKind) {
  const s = await tx.run(zql.notificationSetting.where("id", notificationSettingId(organizationId, userId)).one());
  return !(s?.mutedKinds ?? []).includes(kind);
}

/** Loads the caller's notifications among `ids` (others are ignored on the client, refused on the server) */
async function ownNotifications(tx: Transaction, userID: string, ids: readonly string[]) {
  const rows = await tx.run(zql.notification.where("id", "IN", [...ids]));
  if (tx.location === "server" && rows.some((n) => n.userId !== userID)) throw new PermissionError("Not your notification");
  return rows.filter((n) => n.userId === userID);
}

export const notificationMutators = {
  /** Marks notifications as read (`read: false` marks them unread again) */
  setRead: defineMutator(z.object({ ids: z.array(id).min(1).max(500), read: z.boolean(), at: z.number() }), async ({ tx, ctx, args }) => {
    const when = at(tx, args.at);
    for (const n of await ownNotifications(tx, ctx.userID, args.ids)) {
      if (args.read ? n.readAt : !n.readAt) continue;
      await tx.mutate.notification.update({ id: n.id, readAt: args.read ? when : null });
    }
  }),

  /** Every unread notification of the organization becomes read */
  markAllRead: defineMutator(z.object({ organizationId: id, at: z.number() }), async ({ tx, ctx, args }) => {
    const when = at(tx, args.at);
    if (tx.location === "server") {
      await tx.dbTransaction.query("update notification set read_at = $3 where user_id = $1 and organization_id = $2 and read_at is null", [
        ctx.userID,
        args.organizationId,
        new Date(when),
      ]);
      return;
    }
    // Client: mirror on the rows present locally
    const rows = await tx.run(
      zql.notification.where("userId", ctx.userID).where("organizationId", args.organizationId).where("readAt", "IS", null),
    );
    for (const n of rows) await tx.mutate.notification.update({ id: n.id, readAt: when });
  }),

  /** Hides notifications from the panel (they also become read) */
  archive: defineMutator(z.object({ ids: z.array(id).min(1).max(500), at: z.number() }), async ({ tx, ctx, args }) => {
    const when = at(tx, args.at);
    for (const n of await ownNotifications(tx, ctx.userID, args.ids)) {
      await tx.mutate.notification.update({ id: n.id, archivedAt: when, readAt: n.readAt ?? when });
    }
  }),

  /** Preferences of the caller in an organization */
  updateSettings: defineMutator(
    z.object({
      organizationId: id,
      mutedKinds: z.array(notificationKind).max(20),
      browserEnabled: z.boolean(),
      at: z.number(),
    }),
    async ({ tx, ctx, args }) => {
      if (tx.location === "server") await assertOrgMember(tx, ctx.userID, args.organizationId);
      await tx.mutate.notificationSetting.upsert({
        id: notificationSettingId(args.organizationId, ctx.userID),
        organizationId: args.organizationId,
        userId: ctx.userID,
        mutedKinds: [...new Set(args.mutedKinds)],
        browserEnabled: args.browserEnabled,
        updatedAt: at(tx, args.at),
      });
    },
  ),
};
