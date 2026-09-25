/** /projects, /labels, /tickets (create from messages, update, comments, message links) */
import { ticketStatus } from "@feedbacks/schema/enums";
import { newId } from "@feedbacks/schema/ids";
import {
  DEFAULT_STATUS,
  DEFAULT_STATUS_FROM_MESSAGES,
  descriptionFromMessages,
  parseTicketKey,
  titleFromMessages,
} from "@feedbacks/schema/tickets";
import { channelVisibility, visibleProjects, visibleTickets } from "@feedbacks/schema/zero/permissions";
import { queries } from "@feedbacks/schema/zero/queries";
import { zql } from "@feedbacks/schema/zero/schema";
import { z } from "zod";
import { pool } from "../../db";
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
import { messageOut, toMessages, userRef } from "./chat";

/* ------------------------------ Shapes ------------------------------ */

const PRIORITY_NAMES = ["none", "urgent", "high", "medium", "low"] as const;
const priorityIn = z
  .union([z.number().int().min(0).max(4), z.enum(PRIORITY_NAMES)])
  .describe("0 none · 1 urgent · 2 high · 3 medium · 4 low (number or name)")
  .transform((p) => (typeof p === "number" ? p : PRIORITY_NAMES.indexOf(p)) as 0 | 1 | 2 | 3 | 4);

const projectOut = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  color: z.string(),
  visibility: z.string(),
  archived: z.boolean(),
  role: z.string().nullable().describe("Caller's role: admin, lead, contributor, reporter or viewer"),
  can_create_tickets: z.boolean(),
});

const labelOut = z.object({ id: z.string(), name: z.string(), color: z.string() });

const commentOut = z.object({
  id: z.string(),
  author: userRef.nullable(),
  body: z.string(),
  text: z.string(),
  created_at: z.string(),
  edited_at: z.string().nullable(),
  via: z.string().nullable(),
});

const ticketOut = z.object({
  id: z.string(),
  key: z.string().describe("e.g. APP-12"),
  number: z.number(),
  url: z.string(),
  project: z.object({ id: z.string(), key: z.string(), name: z.string() }),
  title: z.string(),
  description: z.string(),
  status: ticketStatus,
  priority: z.number(),
  priority_name: z.enum(PRIORITY_NAMES),
  assignee: userRef.nullable(),
  creator: userRef.nullable(),
  labels: z.array(labelOut),
  created_via: z.string().describe("app, api or mcp"),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
  source_message_ids: z.array(z.string()),
});

const ticketDetailOut = ticketOut.extend({
  former_keys: z.array(z.string()).describe("Keys the ticket had before being moved to another project"),
  source_messages: z.array(messageOut).describe("Chat messages the ticket was built from (readable by the caller)"),
  comments: z.array(commentOut),
  docs: z.array(z.object({ id: z.string(), title: z.string(), url: z.string() })),
});

/* ------------------------------ Resolution ------------------------------ */

const ctxOf = (caller: Caller) => ({ userID: caller.userId });

async function orgLabels(caller: Caller) {
  return read(zql.label.where("organizationId", caller.organizationId).orderBy("name", "asc"));
}

/** Project by key (case-insensitive) or id, readable by the caller */
async function resolveProject(caller: Caller, ref: string) {
  const base = visibleProjects(caller.userId, caller.organizationId).related("members", (m) => m.where("userId", caller.userId));
  const p = (await read(base.where("key", ref.toUpperCase()).one())) ?? (await read(base.where("id", ref).one()));
  if (!p) throw notFound("Project");
  return p;
}

/** Ticket id from a key ("APP-12", former keys included) or an id */
export async function resolveTicketId(caller: Caller, ref: string): Promise<string> {
  const key = parseTicketKey(ref);
  if (key) {
    const args = { organizationId: caller.organizationId, key: key.key, number: key.number };
    const t = await read(queries.tickets.byKey.fn({ args, ctx: ctxOf(caller) }));
    if (t) return t.id;
    const alias = await read(queries.tickets.aliasByKey.fn({ args, ctx: ctxOf(caller) }));
    if (alias?.ticket) return alias.ticket.id;
  }
  const byId = await read(visibleTickets(caller.userId, caller.organizationId).where("id", ref).one());
  if (byId) return byId.id;
  throw notFound("Ticket");
}

/** Assignee: "me", a user id, or an email of a member; null/"none" unassigns */
async function resolveAssignee(caller: Caller, value: string | null | undefined): Promise<string | null | undefined> {
  if (value === undefined) return undefined;
  if (value === null || value === "none" || value === "") return null;
  if (value === "me") return caller.userId;
  const { rows } = await pool.query<{ id: string }>(
    `select u.id from member m join "user" u on u.id = m.user_id
      where m.organization_id = $1 and (u.id = $2 or lower(u.email) = lower($2))`,
    [caller.organizationId, value],
  );
  const id = rows[0]?.id;
  if (!id) throw new ApiError(400, "invalid_request", `Unknown assignee: ${value}`);
  return id;
}

/** Labels by id or name (case-insensitive) */
async function resolveLabels(caller: Caller, refs: readonly string[]): Promise<string[]> {
  if (!refs.length) return [];
  const all = await orgLabels(caller);
  return refs.map((ref) => {
    const l = all.find((x) => x.id === ref) ?? all.find((x) => x.name.toLowerCase() === ref.toLowerCase());
    if (!l) throw new ApiError(400, "invalid_request", `Unknown label: ${ref}`);
    return l.id;
  });
}

/* ------------------------------ Serialization ------------------------------ */

type TicketRow = {
  id: string;
  number: number;
  title: string;
  description: string | null;
  status: string;
  priority: number | null;
  assigneeId: string | null;
  creatorId: string | null;
  createdVia: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  completedAt: number | null;
  project?: { id: string; key: string; name: string } | undefined;
  labels?: readonly { labelId: string }[];
  sources?: readonly { messageId: string }[];
};

async function toTickets(caller: Caller, rows: readonly TicketRow[]) {
  const slug = await orgSlug(caller.organizationId);
  const labels = new Map((await orgLabels(caller)).map((l) => [l.id, l]));
  const names = await userNames(
    caller.organizationId,
    rows.flatMap((t) => [t.assigneeId, t.creatorId]).filter((x): x is string => !!x),
  );
  const ref = (id: string | null) => (id ? { id, name: names.get(id) ?? "Former member" } : null);
  return rows.map((t) => {
    const key = `${t.project?.key ?? "?"}-${t.number}`;
    const priority = (t.priority ?? 0) as 0 | 1 | 2 | 3 | 4;
    return {
      id: t.id,
      key,
      number: t.number,
      url: links.ticket(slug, key),
      project: { id: t.project?.id ?? "", key: t.project?.key ?? "?", name: t.project?.name ?? "" },
      title: t.title,
      description: t.description ?? "",
      status: t.status as z.infer<typeof ticketStatus>,
      priority,
      priority_name: PRIORITY_NAMES[priority],
      assignee: ref(t.assigneeId),
      creator: ref(t.creatorId),
      labels: (t.labels ?? [])
        .map((l) => labels.get(l.labelId))
        .filter((l): l is NonNullable<typeof l> => !!l)
        .map((l) => ({ id: l.id, name: l.name, color: l.color })),
      created_via: t.createdVia ?? "app",
      created_at: iso(t.createdAt ?? 0) as string,
      updated_at: iso(t.updatedAt ?? 0) as string,
      completed_at: iso(t.completedAt),
      source_message_ids: (t.sources ?? []).map((s) => s.messageId),
    };
  });
}

async function ticketDetail(caller: Caller, ticketId: string) {
  const t = await read(queries.tickets.get.fn({ args: { organizationId: caller.organizationId, ticketId }, ctx: ctxOf(caller) }));
  if (!t) throw notFound("Ticket");
  const [base] = await toTickets(caller, [t]);
  const slug = await orgSlug(caller.organizationId);
  const sources = (t.sources ?? []).map((s) => s.message).filter((m): m is NonNullable<typeof m> => !!m && !m.deletedAt);
  // Source messages with their own ticket chips (same visibility rules as the chat)
  const messages = sources.length
    ? await read(
        zql.message
          .where(
            "id",
            "IN",
            sources.map((m) => m.id),
          )
          .whereExists("channel", (c) => channelVisibility(c, caller.userId, caller.organizationId))
          .related("author")
          .related("attachments", (a) => a.orderBy("createdAt", "asc"))
          .related("reactions")
          .orderBy("createdAt", "asc"),
      )
    : [];
  const names = await userNames(caller.organizationId, mentionIds(t.comments.map((c) => c.body)));
  const aliases = await pool.query<{ key: string; number: number }>(
    "select p.key, a.number from ticket_alias a join project p on p.id = a.project_id where a.ticket_id = $1 order by a.number",
    [t.id],
  );
  return {
    ...(base as NonNullable<typeof base>),
    former_keys: aliases.rows.map((a) => `${a.key}-${a.number}`),
    source_messages: await toMessages(caller, messages),
    comments: t.comments.map((c) => ({
      id: c.id,
      author: c.author ? { id: c.author.id, name: c.author.name } : null,
      body: c.body,
      text: plainText(c.body, names),
      created_at: iso(c.createdAt) as string,
      edited_at: iso(c.editedAt),
      via: c.via ?? null,
    })),
    docs: (t.docLinks ?? [])
      .map((l) => l.doc)
      .filter((d): d is NonNullable<typeof d> => !!d)
      .map((d) => ({ id: d.id, title: d.title, url: links.doc(slug, d.id) })),
  };
}

/* ------------------------------ Projects and labels ------------------------------ */

defineRoute({
  method: "get",
  path: "/projects",
  operationId: "listProjects",
  tag: "Tickets",
  summary: "Projects the caller can read, with their role",
  query: z.object({ include_archived: z.enum(["true", "false"]).optional() }),
  response: z.object({ data: z.array(projectOut) }),
  handler: async ({ caller, query }) => {
    const rows = await read(
      queries.projects.list.fn({
        args: { organizationId: caller.organizationId, includeArchived: query.include_archived === "true" },
        ctx: ctxOf(caller),
      }),
    );
    const admin = caller.role === "owner" || caller.role === "admin";
    return {
      data: rows.map((p) => {
        const role = admin
          ? "admin"
          : (p.members.find((m) => m.userId === caller.userId)?.role ?? (p.visibility === "org" ? "viewer" : null));
        return {
          id: p.id,
          key: p.key,
          name: p.name,
          color: p.color,
          visibility: p.visibility ?? "org",
          archived: !!p.archivedAt,
          role,
          can_create_tickets: role === "admin" || role === "lead" || role === "contributor",
        };
      }),
    };
  },
});

defineRoute({
  method: "get",
  path: "/labels",
  operationId: "listLabels",
  tag: "Tickets",
  summary: "Labels of the organization",
  response: z.object({ data: z.array(labelOut) }),
  handler: async ({ caller }) => ({ data: (await orgLabels(caller)).map((l) => ({ id: l.id, name: l.name, color: l.color })) }),
});

/* ------------------------------ Tickets ------------------------------ */

defineRoute({
  method: "get",
  path: "/tickets",
  operationId: "listTickets",
  tag: "Tickets",
  summary: "Tickets the caller can read, most recently updated first",
  query: z.object({
    project: z.string().max(64).optional().describe("Project key or id"),
    status: z
      .string()
      .optional()
      .describe("Comma-separated statuses, or `open` (not done/canceled)")
      .transform((v) => (v ? v.split(",").map((s) => s.trim()) : undefined)),
    assignee: z.string().max(320).optional().describe("`me`, `none`, a user id or an email"),
    label: z.string().max(80).optional().describe("Label name or id"),
    created_via: z.enum(["app", "api", "mcp"]).optional(),
    updated_since: timeParam.optional(),
    limit: limitParam(200, 50),
    cursor: z.string().max(200).optional(),
  }),
  response: z.object({ data: z.array(ticketOut), next_cursor: z.string().nullable() }),
  handler: async ({ caller, query }) => {
    let q = visibleTickets(caller.userId, caller.organizationId);
    if (query.project) q = q.where("projectId", (await resolveProject(caller, query.project)).id);
    if (query.status) {
      const statuses = query.status.flatMap((s) => (s === "open" ? ["triage", "backlog", "todo", "in_progress", "in_review"] : [s]));
      for (const s of statuses) if (!ticketStatus.safeParse(s).success) throw new ApiError(400, "invalid_request", `Unknown status: ${s}`);
      q = q.where("status", "IN", statuses as z.infer<typeof ticketStatus>[]);
    }
    if (query.assignee) {
      const a = await resolveAssignee(caller, query.assignee);
      q = a === null ? q.where("assigneeId", "IS", null) : q.where("assigneeId", a as string);
    }
    if (query.label) {
      const [labelId] = await resolveLabels(caller, [query.label]);
      q = q.whereExists("labels", (l) => l.where("labelId", labelId as string));
    }
    if (query.created_via) q = q.where("createdVia", query.created_via);
    if (query.updated_since) q = q.where("updatedAt", ">=", query.updated_since);
    if (query.cursor) {
      const cur = decodeCursor(query.cursor);
      q = q.where(({ or, and, cmp }) => or(cmp("updatedAt", "<", cur.t), and(cmp("updatedAt", "=", cur.t), cmp("id", "<", cur.id))));
    }
    const rows = await read(
      q
        .related("project")
        .related("labels")
        .related("sources")
        .orderBy("updatedAt", "desc")
        .orderBy("id", "desc")
        .limit(query.limit + 1),
    );
    const more = rows.length > query.limit;
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    return { data: await toTickets(caller, items), next_cursor: more && last ? encodeCursor(last.updatedAt ?? 0, last.id) : null };
  },
});

defineRoute({
  method: "get",
  path: "/tickets/:ticket",
  operationId: "getTicket",
  tag: "Tickets",
  summary: "One ticket (by key like APP-12, a former key, or id) with source messages, comments and linked documents",
  params: z.object({ ticket: z.string().min(1).max(64) }),
  response: ticketDetailOut,
  handler: async ({ caller, params }) => ticketDetail(caller, await resolveTicketId(caller, params.ticket)),
});

defineRoute({
  method: "post",
  path: "/tickets",
  operationId: "createTicket",
  tag: "Tickets",
  summary: "Create a ticket, optionally from chat messages",
  description:
    "With `source_message_ids`, the title and description default to the messages (deterministic quote, no AI), the status " +
    "defaults to `triage`, and the authors of the messages are notified. A message already backing another ticket is " +
    "refused with 409 `already_linked` (details.links lists them) unless `force: true`. The ticket is marked `created_via: api|mcp`.",
  body: z.object({
    project: z.string().min(1).max(64).describe("Project key or id"),
    title: z.string().trim().min(1).max(300).optional().describe("Required unless source_message_ids is set"),
    description: z.string().max(50_000).optional(),
    status: ticketStatus.optional(),
    priority: priorityIn.optional(),
    assignee: z.string().max(320).nullable().optional().describe("`me`, a user id or an email"),
    labels: z.array(z.string().max(80)).max(20).optional().describe("Label names or ids"),
    source_message_ids: z.array(z.string().min(1).max(64)).max(50).optional(),
    force: z.boolean().optional(),
  }),
  response: ticketDetailOut,
  status: 201,
  handler: async ({ caller, body }) => {
    const project = await resolveProject(caller, body.project);
    const sourceIds = [...new Set(body.source_message_ids ?? [])];
    let title = body.title;
    let description = body.description;
    if (sourceIds.length && (!title || description === undefined)) {
      const msgs = await read(
        zql.message
          .where("id", "IN", sourceIds)
          .where("deletedAt", "IS", null)
          .whereExists("channel", (c) => channelVisibility(c, caller.userId, caller.organizationId))
          .related("author")
          .related("attachments")
          .orderBy("createdAt", "asc"),
      );
      if (msgs.length !== sourceIds.length) throw notFound("Source message");
      const names = await userNames(caller.organizationId, mentionIds(msgs.map((m) => m.body)));
      const sources = msgs.map((m) => ({
        authorName: m.author?.name ?? "?",
        createdAt: m.createdAt ?? 0,
        body: plainText(m.body, names),
        attachmentNames: m.attachments.map((a) => a.name),
      }));
      title ??= titleFromMessages(sources) || "Untitled";
      description ??= descriptionFromMessages(sources);
    }
    if (!title) throw new ApiError(400, "invalid_request", "`title` is required (or pass source_message_ids)");
    const id = newId();
    await mutate(caller, mutators.tickets.create, {
      id,
      organizationId: caller.organizationId,
      eventId: newId(),
      at: Date.now(),
      projectId: project.id,
      title,
      description: description ?? "",
      status: body.status ?? (sourceIds.length ? DEFAULT_STATUS_FROM_MESSAGES : DEFAULT_STATUS),
      priority: body.priority ?? 0,
      assigneeId: (await resolveAssignee(caller, body.assignee)) ?? null,
      labelIds: await resolveLabels(caller, body.labels ?? []),
      sourceMessageIds: sourceIds,
      force: body.force ?? false,
    });
    return ticketDetail(caller, id);
  },
});

defineRoute({
  method: "patch",
  path: "/tickets/:ticket",
  operationId: "updateTicket",
  tag: "Tickets",
  summary: "Update a ticket (title, description, status, priority, assignee, labels, project)",
  description: "`labels` replaces the whole set. Moving to another `project` gives the ticket a new key (the former key keeps working).",
  params: z.object({ ticket: z.string().min(1).max(64) }),
  body: z.object({
    title: z.string().trim().min(1).max(300).optional(),
    description: z.string().max(50_000).optional(),
    status: ticketStatus.optional(),
    priority: priorityIn.optional(),
    assignee: z.string().max(320).nullable().optional(),
    labels: z.array(z.string().max(80)).max(20).optional(),
    project: z.string().min(1).max(64).optional(),
  }),
  response: ticketDetailOut,
  handler: async ({ caller, params, body }) => {
    const ticketId = await resolveTicketId(caller, params.ticket);
    const base = { organizationId: caller.organizationId, ticketId };
    const assigneeId = await resolveAssignee(caller, body.assignee);
    if (
      body.title !== undefined ||
      body.description !== undefined ||
      body.status !== undefined ||
      body.priority !== undefined ||
      assigneeId !== undefined
    ) {
      await mutate(caller, mutators.tickets.update, {
        ...base,
        eventId: newId(),
        at: Date.now(),
        title: body.title,
        description: body.description,
        status: body.status,
        priority: body.priority,
        assigneeId,
      });
    }
    if (body.labels)
      await mutate(caller, mutators.tickets.setLabels, {
        ...base,
        eventId: newId(),
        at: Date.now(),
        labelIds: await resolveLabels(caller, body.labels),
      });
    if (body.project) {
      const project = await resolveProject(caller, body.project);
      await mutate(caller, mutators.tickets.move, { ...base, eventId: newId(), at: Date.now(), projectId: project.id });
    }
    return ticketDetail(caller, ticketId);
  },
});

defineRoute({
  method: "post",
  path: "/tickets/:ticket/comments",
  operationId: "addComment",
  tag: "Tickets",
  summary: "Comment on a ticket (followers are notified; mention people with `<@userId>`)",
  params: z.object({ ticket: z.string().min(1).max(64) }),
  body: z.object({ body: z.string().trim().min(1).max(20_000) }),
  response: commentOut,
  status: 201,
  handler: async ({ caller, params, body }) => {
    const ticketId = await resolveTicketId(caller, params.ticket);
    const id = newId();
    await mutate(caller, mutators.comments.create, {
      id,
      organizationId: caller.organizationId,
      ticketId,
      body: body.body,
      createdAt: Date.now(),
    });
    const c = await read(zql.comment.where("id", id).related("author").one());
    if (!c) throw notFound("Comment");
    const names = await userNames(caller.organizationId, mentionIds([c.body]));
    return {
      id: c.id,
      author: c.author ? { id: c.author.id, name: c.author.name } : null,
      body: c.body,
      text: plainText(c.body, names),
      created_at: iso(c.createdAt) as string,
      edited_at: iso(c.editedAt),
      via: c.via ?? null,
    };
  },
});

defineRoute({
  method: "post",
  path: "/tickets/:ticket/links",
  operationId: "linkMessages",
  tag: "Tickets",
  summary: "Link more chat messages to a ticket (e.g. a precision posted later)",
  description: "Messages already backing another ticket are refused (409 `already_linked`) unless `force: true`.",
  params: z.object({ ticket: z.string().min(1).max(64) }),
  body: z.object({ message_ids: z.array(z.string().min(1).max(64)).min(1).max(50), force: z.boolean().optional() }),
  response: ticketDetailOut,
  handler: async ({ caller, params, body }) => {
    const ticketId = await resolveTicketId(caller, params.ticket);
    await mutate(caller, mutators.tickets.linkMessages, {
      organizationId: caller.organizationId,
      eventId: newId(),
      at: Date.now(),
      ticketId,
      messageIds: body.message_ids,
      force: body.force ?? false,
    });
    return ticketDetail(caller, ticketId);
  },
});

defineRoute({
  method: "delete",
  path: "/tickets/:ticket/links/:message",
  operationId: "unlinkMessage",
  tag: "Tickets",
  summary: "Unlink a source message from a ticket",
  params: z.object({ ticket: z.string().min(1).max(64), message: z.string().min(1).max(64) }),
  response: ticketDetailOut,
  handler: async ({ caller, params }) => {
    const ticketId = await resolveTicketId(caller, params.ticket);
    await mutate(caller, mutators.tickets.unlinkMessage, {
      organizationId: caller.organizationId,
      eventId: newId(),
      at: Date.now(),
      ticketId,
      messageId: params.message,
    });
    return ticketDetail(caller, ticketId);
  },
});
