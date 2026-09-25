/**
 * Row-visibility rules shared by queries and mutators. Queries run on the server with
 * these filters, so clients can only ever sync rows they are allowed to see.
 *
 * Channel rules:
 *  - public channels: readable by every member of the organization, writable once joined
 *    (sending a message in a public channel joins it automatically);
 *  - private channels and direct messages: readable and writable by their members only.
 */
import type { Transaction } from "@rocicorp/zero";
import { zql } from "./schema";

type ChannelQuery = typeof zql.channel;

/** Organizations the user belongs to */
export function myOrganizations(userID: string) {
  return zql.organization.whereExists("members", (m) => m.where("userId", userID));
}

/**
 * Restricts a channel query to what the user may see in an organization:
 * public channels for any org member, private channels and DMs for their members only.
 */
export function channelVisibility(q: ChannelQuery, userID: string, organizationId: string): ChannelQuery {
  return q.where("organizationId", organizationId).where(({ or, and, cmp, exists }) =>
    or(
      and(
        cmp("kind", "public"),
        exists("organization", (o) => o.whereExists("members", (m) => m.where("userId", userID))),
      ),
      exists("members", (m) => m.where("userId", userID)),
    ),
  );
}

export const visibleChannels = (userID: string, organizationId: string) => channelVisibility(zql.channel, userID, organizationId);

/* ------------------------------------------------------------------ */
/* Server-side checks used by mutators (tx.location === "server")      */
/* ------------------------------------------------------------------ */

export class PermissionError extends Error {}

export async function orgMembership(tx: Transaction, userID: string, organizationId: string) {
  return tx.run(zql.member.where("organizationId", organizationId).where("userId", userID).one());
}

export async function assertOrgMember(tx: Transaction, userID: string, organizationId: string) {
  const m = await orgMembership(tx, userID, organizationId);
  if (!m) throw new PermissionError("Not a member of this organization");
  return m;
}

export const isOrgAdmin = (role: string | null | undefined) => role === "owner" || role === "admin";

/** The channel if the user can read it, otherwise throws */
export async function assertCanReadChannel(tx: Transaction, userID: string, organizationId: string, channelId: string) {
  const ch = await tx.run(
    visibleChannels(userID, organizationId)
      .where("id", channelId)
      .related("members", (m) => m.where("userId", userID))
      .one(),
  );
  if (!ch) throw new PermissionError("Channel not found or not accessible");
  return ch;
}

/** Channel creator, organization owners and admins can edit, archive or rename a channel */
export async function assertCanManageChannel(tx: Transaction, userID: string, organizationId: string, channelId: string) {
  const ch = await assertCanReadChannel(tx, userID, organizationId, channelId);
  if (ch.kind === "dm") throw new PermissionError("Direct conversations cannot be managed");
  if (ch.createdBy === userID) return ch;
  const m = await orgMembership(tx, userID, organizationId);
  if (!isOrgAdmin(m?.role)) throw new PermissionError("Only the creator or an admin can manage this channel");
  return ch;
}
