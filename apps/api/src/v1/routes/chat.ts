/** /me, /users, /channels, /messages, /search, /notifications */
import { normalizeChannelName } from "@feedbacks/schema/chat";
import { newId } from "@feedbacks/schema/ids";
import { channelVisibility, ticketVisibilityFilter, visibleChannels } from "@feedbacks/schema/zero/permissions";
import { queries } from "@feedbacks/schema/zero/queries";
import { zql } from "@feedbacks/schema/zero/schema";
import { z } from "zod";
import { pool } from "../../db";
import { SEARCH_KINDS, type SearchKind, searchFor, stripHighlights } from "../../routes/search";
import {
  decodeCursor,
  encodeCursor,
  iso,
  limitParam,
  links,
  mentionIds,
  mutate,
  mutators,
  orgSlug,
  plainText,
  read,
  timeParam,
  userNames,
} from "../common";
import { ApiError, notFound } from "../errors";
import { type Caller, defineRoute } from "../registry";

/* ------------------------------ Shapes ------------------------------ */

export const userRef = z.object({ id: z.string(), name: z.string() });

const attachmentOut = z.object({
  id: z.string(),
  kind: z.string(),
  name: z.string(),
  mime_type: z.string(),
  size: z.number(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  url: z.string().describe("Authenticated download URL (send the same Bearer token)"),
});

export const ticketRef = z.object({ id: z.string(), key: z.string(), title: z.string(), status: z.string(), url: z.string() });

export const messageOut = z.object({
  id: z.string(),
  channel_id: z.string(),
  parent_id: z.string().nullable().describe("Set for thread replies"),
  author: userRef.nullable(),
  body: z.string().describe("Raw body: mentions are `<@userId>` tokens"),
  text: z.string().describe("Body with mentions resolved to @Name"),
  created_at: z.string(),
  edited_at: z.string().nullable(),
  reply_count: z.number(),
  attachments: z.array(attachmentOut),
  reactions: z.array(z.object({ emoji: z.string(), count: z.number() })),
  tickets: z.array(ticketRef).describe("Tickets built from this message (readable by the caller)"),
  linked_ticket_count: z.number().describe("Number of tickets built from this message (0 = unprocessed feedback)"),
  via: z.string().nullable().describe('Agent/client label when posted through the API or MCP ("via …")'),
  url: z.string(),
});
export type MessageOut = z.infer<typeof messageOut>;

const channelOut = z.object({
  id: z.string(),
  kind: z.enum(["public", "private", "dm"]),
  name: z.string().describe("Channel name, or the other members' names for direct messages"),
  topic: z.string().nullable(),
  project_id: z.string().nullable().describe("Default project of tickets created from this channel"),
  archived: z.boolean(),
  is_member: z.boolean(),
  last_message_at: z.string().nullable(),
  url: z.string(),
});

const page = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), next_cursor: z.string().nullable().describe("Pass as `cursor` to get the next page") });

/* ------------------------------ Serialization ------------------------------ */

type MessageRow = {
  id: string;
  channelId: string;
  parentId: string | null;
  authorId: string | null;
  body: string;
  createdAt: number | null;
  editedAt: number | null;
  replyCount: number | null;
  ticketCount: number | null;
  via?: string | null;
  author?: { id: string; name: string } | undefined | null;
  attachments?: readonly {
    id: string;
    kind: string;
    name: string;
    mimeType: string;
    size: number;
    width: number | null;
    height: number | null;
  }[];
  reactions?: readonly { emoji: string }[];
  ticketSources?: readonly {
    ticket?: { id: string; number: number; title: string; status: string; project?: { key: string } | undefined } | undefined;
  }[];
};

export async function toMessages(caller: Caller, rows: readonly MessageRow[]): Promise<MessageOut[]> {
  const slug = await orgSlug(caller.organizationId);
  const names = await userNames(caller.organizationId, mentionIds(rows.map((r) => r.body)));
  return rows.map((m) => {
    const counts = new Map<string, number>();
    for (const r of m.reactions ?? []) counts.set(r.emoji, (counts.get(r.emoji) ?? 0) + 1);
    const tickets = (m.ticketSources ?? [])
      .map((s) => s.ticket)
      .filter((t): t is NonNullable<typeof t> => !!t?.project)
      .map((t) => {
        const key = `${t.project?.key}-${t.number}`;
        return { id: t.id, key, title: t.title, status: t.status, url: links.ticket(slug, key) };
      });
    return {
      id: m.id,
      channel_id: m.channelId,
      parent_id: m.parentId,
      author: m.author ? { id: m.author.id, name: m.author.name } : null,
      body: m.body,
      text: plainText(m.body, names),
      created_at: iso(m.createdAt ?? 0) as string,
      edited_at: iso(m.editedAt),
      reply_count: m.replyCount ?? 0,
      attachments: (m.attachments ?? []).map((a) => ({
        id: a.id,
        kind: a.kind,
        name: a.name,
        mime_type: a.mimeType,
        size: a.size,
        width: a.width,
        height: a.height,
        url: links.file(a.id),
      })),
      reactions: [...counts].map(([emoji, count]) => ({ emoji, count })),
      tickets,
      linked_ticket_count: m.ticketCount ?? 0,
      via: m.via ?? null,
      url: links.message(slug, m.channelId, m.id, m.parentId),
    };
  });
}

/** Relations every message listing brings (attachments, reactions, tickets readable by the caller) */
function withMessageRelations(q: typeof zql.message, caller: Caller) {
  return q
    .related("author")
    .related("attachments", (a) => a.orderBy("createdAt", "asc"))
    .related("reactions")
    .related("ticketSources", (s) =>
      s.related("ticket", (t) => ticketVisibilityFilter(t, caller.userId, caller.organizationId).related("project")),
    );
}

/* ------------------------------ Channels ------------------------------ */

/** `#name`, `name` or channel id → a channel the caller can read */
export async function resolveChannel(caller: Caller, ref: string) {
  const base = visibleChannels(caller.userId, caller.organizationId).related("members", (m) => m.where("userId", caller.userId));
  const byId = await read(base.where("id", ref).one());
  if (byId) return byId;
  const name = normalizeChannelName(ref);
  const byName = await read(base.where("name", name).where("kind", "!=", "dm").one());
  if (byName) return byName;
  throw notFound("Channel");
}

async function dmTitles(caller: Caller, channelIds: string[]) {
  if (!channelIds.length) return new Map<string, string>();
  const { rows } = await pool.query<{ channel_id: string; names: string[] }>(
    `select cm.channel_id, array_agg(u.name order by u.name) as names
       from channel_member cm join "user" u on u.id = cm.user_id
      where cm.channel_id = any($1) and cm.user_id <> $2
      group by cm.channel_id`,
    [channelIds, caller.userId],
  );
  return new Map(rows.map((r) => [r.channel_id, r.names.join(", ")]));
}

type ChannelRow = {
  id: string;
  kind: string;
  name: string;
  topic: string | null;
  projectId: string | null;
  archivedAt: number | null;
  lastMessageAt: number | null;
  members: readonly { userId: string }[];
};

async function toChannels(caller: Caller, rows: readonly ChannelRow[]) {
  const slug = await orgSlug(caller.organizationId);
  const dms = await dmTitles(
    caller,
    rows.filter((r) => r.kind === "dm").map((r) => r.id),
  );
  return rows.map((c) => ({
    id: c.id,
    kind: c.kind as "public" | "private" | "dm",
    name: c.kind === "dm" ? (dms.get(c.id) ?? "Direct message") : c.name,
    topic: c.topic,
    project_id: c.projectId,
    archived: !!c.archivedAt,
    is_member: c.members.some((m) => m.userId === caller.userId),
    last_message_at: iso(c.lastMessageAt),
    url: links.channel(slug, c.id),
  }));
}

/* ------------------------------ Routes ------------------------------ */

defineRoute({
  method: "get",
  path: "/me",
  operationId: "getMe",
  tag: "Account",
  summary: "Who am I: the token's user, organization, role and scope",
  response: z.object({
    user: z.object({ id: z.string(), name: z.string(), email: z.string() }),
    organization: z.object({ id: z.string(), name: z.string(), slug: z.string() }),
    role: z.string().describe("Organization role: owner, admin or member"),
    token: z.object({ id: z.string(), scope: z.enum(["read", "read-write"]) }),
  }),
  handler: async ({ caller }) => {
    const { rows } = await pool.query<{ email: string; org_name: string; slug: string }>(
      `select u.email, o.name as org_name, o.slug from "user" u, organization o where u.id = $1 and o.id = $2`,
      [caller.userId, caller.organizationId],
    );
    const r = rows[0];
    if (!r) throw notFound("User");
    return {
      user: { id: caller.userId, name: caller.userName, email: r.email },
      organization: { id: caller.organizationId, name: r.org_name, slug: r.slug },
      role: caller.role,
      token: { id: caller.tokenId, scope: caller.scope },
    };
  },
});

defineRoute({
  method: "get",
  path: "/users",
  operationId: "listUsers",
  tag: "Account",
  summary: "Members of the organization (ids for mentions `<@id>`, assignees)",
  response: z.object({ data: z.array(z.object({ id: z.string(), name: z.string(), email: z.string(), role: z.string() })) }),
  handler: async ({ caller }) => {
    const { rows } = await pool.query<{ id: string; name: string; email: string; role: string }>(
      `select u.id, u.name, u.email, m.role from member m join "user" u on u.id = m.user_id
        where m.organization_id = $1 order by u.name`,
      [caller.organizationId],
    );
    return { data: rows };
  },
});

defineRoute({
  method: "get",
  path: "/channels",
  operationId: "listChannels",
  tag: "Chat",
  summary: "Channels the caller can read (public channels, private channels and DMs they belong to)",
  query: z.object({
    kind: z.enum(["public", "private", "dm"]).optional(),
    joined: z.enum(["true", "false"]).optional().describe("true = only channels the caller is a member of"),
    include_archived: z.enum(["true", "false"]).optional(),
  }),
  response: z.object({ data: z.array(channelOut) }),
  handler: async ({ caller, query }) => {
    let q = visibleChannels(caller.userId, caller.organizationId).related("members", (m) => m.where("userId", caller.userId));
    if (query.kind) q = q.where("kind", query.kind);
    if (query.include_archived !== "true") q = q.where("archivedAt", "IS", null);
    if (query.joined === "true") q = q.whereExists("members", (m) => m.where("userId", caller.userId));
    const rows = await read(q.orderBy("name", "asc").limit(1000));
    return { data: await toChannels(caller, rows) };
  },
});

defineRoute({
  method: "get",
  path: "/channels/:channel",
  operationId: "getChannel",
  tag: "Chat",
  summary: "One channel, by id or name (`#feedback` or `feedback`)",
  params: z.object({ channel: z.string().min(1).max(320) }),
  response: channelOut,
  handler: async ({ caller, params }) => (await toChannels(caller, [await resolveChannel(caller, params.channel)]))[0] as never,
});

defineRoute({
  method: "get",
  path: "/channels/:channel/messages",
  operationId: "listMessages",
  tag: "Chat",
  summary: "Top-level messages of a channel, newest first",
  description:
    "Thread replies are not included (see `reply_count` and GET /messages/{id}/thread). " +
    "`unprocessed=true` keeps messages of other people that no ticket was built from yet: the feedback still to triage.",
  params: z.object({ channel: z.string().min(1).max(320) }),
  query: z.object({
    since: timeParam.optional().describe('ISO date, epoch ms or a duration ago ("24h", "7d")'),
    until: timeParam.optional(),
    unprocessed: z.enum(["true", "false"]).optional(),
    limit: limitParam(200, 50),
    cursor: z.string().max(200).optional(),
  }),
  response: page(messageOut),
  handler: async ({ caller, params, query }) => {
    const ch = await resolveChannel(caller, params.channel);
    let q = zql.message
      .where("channelId", ch.id)
      .where("parentId", "IS", null)
      .where("deletedAt", "IS", null)
      .whereExists("channel", (c) => channelVisibility(c, caller.userId, caller.organizationId));
    if (query.unprocessed === "true") q = q.where("authorId", "!=", caller.userId).where("ticketCount", 0);
    if (query.since) q = q.where("createdAt", ">=", query.since);
    if (query.until) q = q.where("createdAt", "<", query.until);
    if (query.cursor) {
      const cur = decodeCursor(query.cursor);
      q = q.where(({ or, and, cmp }) => or(cmp("createdAt", "<", cur.t), and(cmp("createdAt", "=", cur.t), cmp("id", "<", cur.id))));
    }
    const rows = await read(
      withMessageRelations(q, caller)
        .orderBy("createdAt", "desc")
        .orderBy("id", "desc")
        .limit(query.limit + 1),
    );
    const more = rows.length > query.limit;
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    return { data: await toMessages(caller, items), next_cursor: more && last ? encodeCursor(last.createdAt ?? 0, last.id) : null };
  },
});

async function readableMessage(caller: Caller, id: string) {
  const row = await read(
    withMessageRelations(
      zql.message
        .where("id", id)
        .where("deletedAt", "IS", null)
        .whereExists("channel", (c) => channelVisibility(c, caller.userId, caller.organizationId)),
      caller,
    ).one(),
  );
  if (!row) throw notFound("Message");
  return row;
}

defineRoute({
  method: "get",
  path: "/messages/:id",
  operationId: "getMessage",
  tag: "Chat",
  summary: "One message",
  params: z.object({ id: z.string().min(1).max(64) }),
  response: messageOut,
  handler: async ({ caller, params }) => (await toMessages(caller, [await readableMessage(caller, params.id)]))[0] as never,
});

defineRoute({
  method: "get",
  path: "/messages/:id/thread",
  operationId: "getThread",
  tag: "Chat",
  summary: "A thread: the parent message and its replies, oldest first",
  params: z.object({ id: z.string().min(1).max(64) }),
  response: z.object({ parent: messageOut, replies: z.array(messageOut) }),
  handler: async ({ caller, params }) => {
    const first = await readableMessage(caller, params.id);
    const parentId = first.parentId ?? first.id;
    const parent = parentId === first.id ? first : await readableMessage(caller, parentId);
    const replies = await read(
      withMessageRelations(zql.message.where("parentId", parentId).where("deletedAt", "IS", null), caller)
        .orderBy("createdAt", "asc")
        .limit(1000),
    );
    const [p, ...r] = await toMessages(caller, [parent, ...replies]);
    return { parent: p as MessageOut, replies: r };
  },
});

const postBody = z.object({
  body: z.string().trim().min(1).max(20_000).describe("Markdown; mention people with `<@userId>` (see GET /users)"),
});

async function postMessage(caller: Caller, channelId: string, body: string, parentId: string | null) {
  const id = newId();
  await mutate(caller, mutators.messages.send, {
    id,
    organizationId: caller.organizationId,
    channelId,
    body,
    parentId,
    createdAt: Date.now(),
  });
  return (await toMessages(caller, [await readableMessage(caller, id)]))[0] as MessageOut;
}

defineRoute({
  method: "post",
  path: "/channels/:channel/messages",
  operationId: "postMessage",
  tag: "Chat",
  summary: "Post a message in a channel (shown as posted by the token's user, marked `via …`)",
  params: z.object({ channel: z.string().min(1).max(320) }),
  body: postBody,
  response: messageOut,
  status: 201,
  handler: async ({ caller, params, body }) => {
    const ch = await resolveChannel(caller, params.channel);
    return postMessage(caller, ch.id, body.body, null);
  },
});

defineRoute({
  method: "post",
  path: "/messages/:id/replies",
  operationId: "replyInThread",
  tag: "Chat",
  summary: "Reply in the thread of a message (e.g. to ask for details or announce the ticket key)",
  params: z.object({ id: z.string().min(1).max(64) }),
  body: postBody,
  response: messageOut,
  status: 201,
  handler: async ({ caller, params, body }) => {
    const m = await readableMessage(caller, params.id);
    return postMessage(caller, m.channelId, body.body, m.parentId ?? m.id);
  },
});

/* ------------------------------ Search ------------------------------ */

const searchResult = z.object({
  kind: z.enum(SEARCH_KINDS),
  id: z.string().describe("Id of the message, ticket, comment or document"),
  title: z.string(),
  snippet: z.string(),
  created_at: z.string(),
  author: userRef.nullable(),
  channel: z.object({ id: z.string(), name: z.string() }).nullable(),
  parent_id: z.string().nullable(),
  ticket: z.object({ id: z.string(), key: z.string(), title: z.string(), status: z.string() }).nullable(),
  doc: z.object({ id: z.string(), title: z.string() }).nullable(),
  url: z.string(),
});

export async function runSearch(
  caller: Caller,
  q: { q: string; types?: SearchKind[] | null; channelId?: string; projectId?: string; authorId?: string; limit: number },
) {
  const results = await searchFor(caller.organizationId, caller.userId, { ...q, types: q.types ?? null });
  if (!results) throw new ApiError(403, "forbidden", "Not a member of this organization");
  const slug = await orgSlug(caller.organizationId);
  return results.map((r) => ({
    kind: r.kind,
    id: r.entityId,
    title: stripHighlights(r.title),
    snippet: stripHighlights(r.snippet),
    created_at: iso(r.createdAt) as string,
    author: r.author,
    channel: r.channel ? { id: r.channel.id, name: r.channel.name } : null,
    parent_id: r.parentId,
    ticket: r.ticket ? { id: r.ticket.id, key: r.ticket.key, title: r.ticket.title, status: r.ticket.status } : null,
    doc: r.doc ? { id: r.doc.id, title: r.doc.title } : null,
    url:
      r.kind === "doc" && r.doc
        ? links.doc(slug, r.doc.id)
        : r.kind === "message" && r.channel
          ? links.message(slug, r.channel.id, r.entityId, r.parentId)
          : r.ticket
            ? links.ticket(slug, r.ticket.key)
            : "",
  }));
}

defineRoute({
  method: "get",
  path: "/search",
  operationId: "search",
  tag: "Search",
  summary: "Full-text search in messages, tickets, comments and documents the caller can read",
  description: "Every word is a prefix; case and accents are ignored. Results are ranked, then newest first.",
  query: z.object({
    q: z.string().trim().min(1).max(200),
    types: z
      .string()
      .optional()
      .describe("Comma-separated: message,ticket,comment,doc")
      .transform((v) => (v ? v.split(",").filter((k): k is SearchKind => (SEARCH_KINDS as readonly string[]).includes(k)) : null)),
    channel: z.string().max(320).optional().describe("Channel id or name"),
    project: z.string().max(64).optional().describe("Project key or id"),
    limit: limitParam(50, 20),
  }),
  response: z.object({ data: z.array(searchResult) }),
  handler: async ({ caller, query }) => {
    const channelId = query.channel ? (await resolveChannel(caller, query.channel)).id : undefined;
    let projectId: string | undefined;
    if (query.project) {
      const { rows } = await pool.query<{ id: string }>(
        "select id from project where organization_id = $1 and (id = $2 or key = upper($2))",
        [caller.organizationId, query.project],
      );
      projectId = rows[0]?.id ?? "-";
    }
    return { data: await runSearch(caller, { q: query.q, types: query.types, channelId, projectId, limit: query.limit }) };
  },
});

/* ------------------------------ Notifications ------------------------------ */

const notificationOut = z.object({
  id: z.string(),
  kind: z.string(),
  actor: userRef.nullable(),
  body: z.string(),
  ticket: z.object({ id: z.string(), key: z.string(), title: z.string() }).nullable(),
  message_id: z.string().nullable(),
  channel_id: z.string().nullable(),
  doc_id: z.string().nullable(),
  created_at: z.string(),
  read_at: z.string().nullable(),
});

defineRoute({
  method: "get",
  path: "/notifications",
  operationId: "listNotifications",
  tag: "Notifications",
  summary: "The caller's notifications, newest first",
  query: z.object({ filter: z.enum(["unread", "all"]).default("unread"), limit: limitParam(200, 50) }),
  response: z.object({ data: z.array(notificationOut) }),
  handler: async ({ caller, query }) => {
    const rows = await read(
      queries.notifications.list.fn({
        args: { organizationId: caller.organizationId, filter: query.filter, limit: query.limit },
        ctx: { userID: caller.userId },
      }),
    );
    return {
      data: rows.map((n) => ({
        id: n.id,
        kind: n.kind,
        actor: n.actor ? { id: n.actor.id, name: n.actor.name } : null,
        body: n.body ?? "",
        ticket: n.ticket?.project ? { id: n.ticket.id, key: `${n.ticket.project.key}-${n.ticket.number}`, title: n.ticket.title } : null,
        message_id: n.messageId,
        channel_id: n.channelId,
        doc_id: n.docId,
        created_at: iso(n.createdAt) as string,
        read_at: iso(n.readAt),
      })),
    };
  },
});

defineRoute({
  method: "post",
  path: "/notifications/read",
  operationId: "markNotificationsRead",
  tag: "Notifications",
  summary: "Mark notifications as read (`ids`), or all of them (`all: true`)",
  body: z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(500).optional(), all: z.boolean().optional() }),
  response: z.object({ ok: z.literal(true) }),
  handler: async ({ caller, body }) => {
    if (body.all) await mutate(caller, mutators.notifications.markAllRead, { organizationId: caller.organizationId, at: Date.now() });
    else if (body.ids?.length) await mutate(caller, mutators.notifications.setRead, { ids: body.ids, read: true, at: Date.now() });
    else throw new ApiError(400, "invalid_request", "Pass `ids` or `all: true`");
    return { ok: true as const };
  },
});
