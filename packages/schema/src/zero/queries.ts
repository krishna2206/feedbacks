import { defineQueries, defineQuery } from "@rocicorp/zero";
import { z } from "zod";
import {
  channelVisibility,
  myOrganizations,
  ticketVisibilityFilter,
  visibleChannels,
  visibleProjects,
  visibleTickets,
} from "./permissions";
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
    /** Projects the user can read (sidebar, pickers), with members for roles and assignee pickers */
    list: defineQuery(z.object({ organizationId: id, includeArchived: z.boolean().default(false) }), ({ ctx, args }) => {
      const q = visibleProjects(ctx.userID, args.organizationId)
        .related("members", (m) => m.orderBy("createdAt", "asc"))
        .orderBy("name", "asc");
      return args.includeArchived ? q : q.where("archivedAt", "IS", null);
    }),
    /** One project by key (project pages) */
    byKey: defineQuery(z.object({ organizationId: id, key: z.string().min(1).max(10) }), ({ ctx, args }) =>
      visibleProjects(ctx.userID, args.organizationId)
        .where("key", args.key)
        .related("members", (m) => m.related("user").orderBy("createdAt", "asc"))
        .one(),
    ),
  },
  labels: {
    list: defineQuery(z.object({ organizationId: id }), ({ ctx, args }) =>
      zql.label
        .where("organizationId", args.organizationId)
        .whereExists("organization", (o) => o.whereExists("members", (m) => m.where("userId", ctx.userID)))
        .orderBy("name", "asc"),
    ),
  },
  tickets: {
    /** Every readable ticket of a project (list and board are computed client-side from this set) */
    byProject: defineQuery(z.object({ organizationId: id, projectId: id }), ({ ctx, args }) =>
      visibleTickets(ctx.userID, args.organizationId)
        .where("projectId", args.projectId)
        .related("labels")
        .related("sources")
        .orderBy("updatedAt", "desc")
        .limit(5000),
    ),
    /** "My tickets": assigned to me, created by me, or built from my messages */
    mine: defineQuery(z.object({ organizationId: id, filter: z.enum(["assigned", "created", "reported"]) }), ({ ctx, args }) => {
      const base = visibleTickets(ctx.userID, args.organizationId);
      const q =
        args.filter === "assigned"
          ? base.where("assigneeId", ctx.userID)
          : args.filter === "created"
            ? base.where("creatorId", ctx.userID)
            : base.whereExists("sources", (s) => s.whereExists("message", (m) => m.where("authorId", ctx.userID)));
      return q.related("labels").related("sources").related("project").orderBy("updatedAt", "desc").limit(1000);
    }),
    /** Ticket page */
    get: defineQuery(z.object({ organizationId: id, ticketId: id }), ({ ctx, args }) =>
      visibleTickets(ctx.userID, args.organizationId)
        .where("id", args.ticketId)
        .related("project")
        .related("labels")
        .related("aliases")
        .related("sources", (s) =>
          s.orderBy("addedAt", "asc").related("message", (m) =>
            m
              .whereExists("channel", (c) => channelVisibility(c, ctx.userID, args.organizationId))
              .related("author")
              .related("channel")
              .related("attachments", (a) => a.orderBy("createdAt", "asc")),
          ),
        )
        .related("comments", (c) =>
          c
            .orderBy("createdAt", "asc")
            .related("author")
            .related("reactions", (r) => r.orderBy("createdAt", "asc")),
        )
        .related("activities", (a) => a.orderBy("createdAt", "asc"))
        .one(),
    ),
    /** Resolves "APP-12" without needing the project list (works for tickets readable as a source author) */
    byKey: defineQuery(
      z.object({ organizationId: id, key: z.string().min(1).max(10), number: z.number().int().positive() }),
      ({ ctx, args }) =>
        visibleTickets(ctx.userID, args.organizationId)
          .where("number", args.number)
          .whereExists("project", (p) => p.where("key", args.key))
          .related("project")
          .one(),
    ),
    /** Former key of a moved ticket, e.g. APP-12 → OPS-3 */
    aliasByKey: defineQuery(
      z.object({ organizationId: id, key: z.string().min(1).max(10), number: z.number().int().positive() }),
      ({ ctx, args }) =>
        zql.ticketAlias
          .where("organizationId", args.organizationId)
          .where("number", args.number)
          .whereExists("project", (p) => p.where("key", args.key))
          .whereExists("ticket", (t) => ticketVisibilityFilter(t, ctx.userID, args.organizationId))
          .related("ticket", (t) => t.related("project"))
          .one(),
    ),
    /** Resolves a key: current number of a project… */
    byNumber: defineQuery(z.object({ organizationId: id, projectId: id, number: z.number().int().positive() }), ({ ctx, args }) =>
      visibleTickets(ctx.userID, args.organizationId).where("projectId", args.projectId).where("number", args.number).one(),
    ),
    /** …or a former key of a ticket moved to another project */
    alias: defineQuery(z.object({ organizationId: id, projectId: id, number: z.number().int().positive() }), ({ ctx, args }) =>
      zql.ticketAlias
        .where("projectId", args.projectId)
        .where("number", args.number)
        .whereExists("ticket", (t) => ticketVisibilityFilter(t, ctx.userID, args.organizationId))
        .related("ticket", (t) => t.related("project"))
        .one(),
    ),
    /** Recently updated readable tickets (link picker, command menu) */
    recent: defineQuery(z.object({ organizationId: id, limit: z.number().int().min(1).max(500).default(200) }), ({ ctx, args }) =>
      visibleTickets(ctx.userID, args.organizationId).related("project").orderBy("updatedAt", "desc").limit(args.limit),
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
          // Tickets built from the message: chips for readable tickets; the link rows alone flag "already linked"
          .related("ticketSources", (s) =>
            s.related("ticket", (t) => ticketVisibilityFilter(t, ctx.userID, args.organizationId).related("project")),
          )
          .orderBy("createdAt", "desc")
          .limit(args.limit),
    ),
    /** Specific messages (sources of a ticket being created), with the tickets they already back */
    byIds: defineQuery(z.object({ organizationId: id, ids: z.array(id).max(50) }), ({ ctx, args }) =>
      zql.message
        .where("id", "IN", args.ids)
        .where("deletedAt", "IS", null)
        .whereExists("channel", (c) => channelVisibility(c, ctx.userID, args.organizationId))
        .related("author")
        .related("channel")
        .related("attachments", (a) => a.orderBy("createdAt", "asc"))
        .related("ticketSources", (s) =>
          s.related("ticket", (t) => ticketVisibilityFilter(t, ctx.userID, args.organizationId).related("project")),
        )
        .orderBy("createdAt", "asc"),
    ),
    /** "Unprocessed": top-level messages of other people that no ticket was built from yet */
    unprocessed: defineQuery(
      z.object({ organizationId: id, channelId, limit: z.number().int().min(1).max(1000).default(200) }),
      ({ ctx, args }) =>
        zql.message
          .where("channelId", args.channelId)
          .where("parentId", "IS", null)
          .where("deletedAt", "IS", null)
          .where("authorId", "!=", ctx.userID)
          .where("ticketCount", 0)
          .whereExists("channel", (c) => channelVisibility(c, ctx.userID, args.organizationId))
          .related("author")
          .related("attachments", (a) => a.orderBy("createdAt", "asc"))
          .related("reactions", (r) => r.orderBy("createdAt", "asc").related("user"))
          .related("replies", (r) => r.where("deletedAt", "IS", null).orderBy("createdAt", "desc").limit(3).related("author"))
          .related("ticketSources")
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
