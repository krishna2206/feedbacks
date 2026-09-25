import { defineQueries, defineQuery } from "@rocicorp/zero";
import { z } from "zod";
import { channelVisibility, myOrganizations, visibleChannels } from "./permissions";
import { zql } from "./schema";

const id = z.string().min(1).max(64);
/** Channel ids are longer for direct messages (see dmChannelId) */
const channelId = z.string().min(1).max(320);

export const queries = defineQueries({
  orgs: {
    /** Organizations of the current user, with members and their public profile */
    mine: defineQuery(({ ctx }) =>
      myOrganizations(ctx.userID)
        .related("members", (m) => m.related("user"))
        .orderBy("name", "asc"),
    ),
  },
  projects: {
    /** Projects of an organization (default project picker of channels; managed in M2) */
    list: defineQuery(z.object({ organizationId: id }), ({ ctx, args }) =>
      zql.project
        .where("organizationId", args.organizationId)
        .where("archivedAt", "IS", null)
        .whereExists("organization", (o) => o.whereExists("members", (m) => m.where("userId", ctx.userID)))
        .orderBy("name", "asc"),
    ),
  },
  channels: {
    /** Every channel the user can see in an organization (joined or not) */
    list: defineQuery(z.object({ organizationId: id }), ({ ctx, args }) =>
      visibleChannels(ctx.userID, args.organizationId)
        .related("members", (m) => m.where("userId", ctx.userID))
        .orderBy("name", "asc"),
    ),
    /** Sidebar: channels the user joined (DMs excluded), with their own membership for unread counts */
    mine: defineQuery(z.object({ organizationId: id }), ({ ctx, args }) =>
      zql.channel
        .where("organizationId", args.organizationId)
        .where("kind", "!=", "dm")
        .where("archivedAt", "IS", null)
        .whereExists("members", (m) => m.where("userId", ctx.userID))
        .whereExists("organization", (o) => o.whereExists("members", (m) => m.where("userId", ctx.userID)))
        .related("members", (m) => m.where("userId", ctx.userID))
        .orderBy("name", "asc"),
    ),
    /** Sidebar: direct conversations, with every member (to display names and avatars) */
    dms: defineQuery(z.object({ organizationId: id }), ({ ctx, args }) =>
      zql.channel
        .where("organizationId", args.organizationId)
        .where("kind", "dm")
        .whereExists("members", (m) => m.where("userId", ctx.userID))
        .whereExists("organization", (o) => o.whereExists("members", (m) => m.where("userId", ctx.userID)))
        .related("members", (m) => m.related("user"))
        .orderBy("lastMessageAt", "desc")
        .limit(50),
    ),
    /** "Browse channels": public channels of the organization, with the user's membership if any */
    browse: defineQuery(z.object({ organizationId: id }), ({ ctx, args }) =>
      channelVisibility(zql.channel, ctx.userID, args.organizationId)
        .where("kind", "public")
        .related("members", (m) => m.where("userId", ctx.userID))
        .orderBy("name", "asc"),
    ),
    /** One channel with its members (header, member list, mention candidates of private channels) */
    get: defineQuery(z.object({ organizationId: id, channelId }), ({ ctx, args }) =>
      visibleChannels(ctx.userID, args.organizationId)
        .where("id", args.channelId)
        .related("members", (m) => m.related("user"))
        .related("project")
        .one(),
    ),
  },
  messages: {
    /**
     * Latest top-level messages of a channel, newest first (the client reverses them).
     * Thread replies are fetched separately; `replies` only brings the last 3 authors for the summary.
     * Deleted messages are kept only while they still have replies (shown as a placeholder).
     */
    byChannel: defineQuery(
      z.object({ organizationId: id, channelId, limit: z.number().int().min(1).max(1000).default(100) }),
      ({ ctx, args }) =>
        zql.message
          .where("channelId", args.channelId)
          .where("parentId", "IS", null)
          .where(({ or, cmp }) => or(cmp("deletedAt", "IS", null), cmp("replyCount", ">", 0)))
          .whereExists("channel", (c) => channelVisibility(c, ctx.userID, args.organizationId))
          .related("author")
          .related("attachments", (a) => a.orderBy("createdAt", "asc"))
          .related("reactions", (r) => r.orderBy("createdAt", "asc").related("user"))
          .related("replies", (r) => r.where("deletedAt", "IS", null).orderBy("createdAt", "desc").limit(3).related("author"))
          .orderBy("createdAt", "desc")
          .limit(args.limit),
    ),
    /** A thread: the parent message and all its replies, oldest first */
    thread: defineQuery(z.object({ organizationId: id, parentId: id }), ({ ctx, args }) =>
      zql.message
        .where("id", args.parentId)
        .whereExists("channel", (c) => channelVisibility(c, ctx.userID, args.organizationId))
        .related("author")
        .related("attachments", (a) => a.orderBy("createdAt", "asc"))
        .related("reactions", (r) => r.orderBy("createdAt", "asc").related("user"))
        .related("replies", (r) =>
          r
            .where("deletedAt", "IS", null)
            .orderBy("createdAt", "asc")
            .related("author")
            .related("attachments", (a) => a.orderBy("createdAt", "asc"))
            .related("reactions", (x) => x.orderBy("createdAt", "asc").related("user")),
        )
        .one(),
    ),
  },
});
