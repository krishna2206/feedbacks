import { defineQueries, defineQuery } from "@rocicorp/zero";
import { z } from "zod";
import { channelVisibility, myOrganizations, visibleChannels } from "./permissions";
import { zql } from "./schema";

const id = z.string().min(1).max(64);

export const queries = defineQueries({
  orgs: {
    /** Organizations of the current user, with members and their public profile */
    mine: defineQuery(({ ctx }) =>
      myOrganizations(ctx.userID)
        .related("members", (m) => m.related("user"))
        .orderBy("name", "asc"),
    ),
  },
  channels: {
    /** Channels the user can see in an organization */
    list: defineQuery(z.object({ organizationId: id }), ({ ctx, args }) =>
      visibleChannels(ctx.userID, args.organizationId)
        .related("members", (m) => m.where("userId", ctx.userID))
        .orderBy("name", "asc"),
    ),
    get: defineQuery(z.object({ organizationId: id, channelId: id }), ({ ctx, args }) =>
      visibleChannels(ctx.userID, args.organizationId).where("id", args.channelId).one(),
    ),
  },
  messages: {
    /** Latest top-level messages of a channel (thread replies are fetched separately) */
    byChannel: defineQuery(
      z.object({ organizationId: id, channelId: id, limit: z.number().int().min(1).max(500).default(100) }),
      ({ ctx, args }) =>
        zql.message
          .where("channelId", args.channelId)
          .where("parentId", "IS", null)
          .whereExists("channel", (c) => channelVisibility(c, ctx.userID, args.organizationId))
          .related("author")
          .orderBy("createdAt", "desc")
          .limit(args.limit),
    ),
  },
});
