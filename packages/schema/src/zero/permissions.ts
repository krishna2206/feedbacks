/**
 * Row-visibility rules shared by queries and mutators. Queries run on the server with
 * these filters, so clients can only ever sync rows they are allowed to see.
 */
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
