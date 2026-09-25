/**
 * Projects, labels, tickets and comments.
 *
 * - Numbering: `project.ticket_counter` is incremented with `UPDATE … RETURNING` inside the server
 *   transaction, which row-locks the project: concurrent creations are serialized, numbers are unique
 *   and contiguous (a failed transaction rolls the counter back). The client shows a provisional number
 *   (local counter + 1) until the authoritative row syncs back.
 * - Sources: a message can back several tickets only on purpose (`force`); otherwise the server refuses
 *   with an ALREADY_LINKED error that lists the existing links (same rule for the web app, API and MCP).
 * - Activities and notifications use ids derived from the caller's `eventId`, so optimistic (client)
 *   and authoritative (server) runs write the same rows.
 */
import "./context";
import { ApplicationError, defineMutator, type Transaction } from "@rocicorp/zero";
import { z } from "zod";
import { excerpt, mentionedUserIds } from "../chat";
import {
  type ActivityKind,
  type NotificationKind,
  projectRole as projectRoleEnum,
  projectVisibility,
  ticketPriority,
  ticketStatus,
} from "../enums";
import {
  ALREADY_LINKED,
  alreadyLinkedMessage,
  canComment,
  canEditTickets,
  canManageProject,
  type EffectiveProjectRole,
  isClosedStatus,
  isValidProjectKey,
  normalizeProjectKey,
  ticketKey,
} from "../tickets";
import { wantsNotification } from "./mutators-notifications";
import {
  assertCanReadChannel,
  assertOrgMember,
  assertProjectAccess,
  isOrgAdmin,
  isSourceAuthor,
  orgMembership,
  PermissionError,
  projectRole,
} from "./permissions";
import { zql } from "./schema";

const id = z.string().min(1).max(64);
const emoji = z.string().min(1).max(32);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const at = (tx: Transaction, clientTime: number) => (tx.location === "server" ? Date.now() : clientTime);

async function sqlOne<T>(tx: Transaction, sql: string, params: unknown[]): Promise<T | undefined> {
  if (tx.location !== "server") return undefined;
  for (const row of await tx.dbTransaction.query(sql, params)) return row as T;
  return undefined;
}
async function sqlAll<T>(tx: Transaction, sql: string, params: unknown[]): Promise<T[]> {
  if (tx.location !== "server") return [];
  return [...(await tx.dbTransaction.query(sql, params))] as T[];
}

async function addActivity(
  tx: Transaction,
  a: {
    eventId: string;
    organizationId: string;
    ticketId: string;
    actorId: string;
    kind: ActivityKind;
    from?: string | null;
    to?: string | null;
    at: number;
  },
) {
  await tx.mutate.activity.upsert({
    id: `${a.eventId}:${a.kind}`,
    organizationId: a.organizationId,
    ticketId: a.ticketId,
    actorId: a.actorId,
    kind: a.kind,
    fromValue: a.from ?? null,
    toValue: a.to ?? null,
    createdAt: a.at,
  });
}

/** Server-only: notifications matter to their recipients, who get them through sync */
async function notify(
  tx: Transaction,
  n: {
    eventId: string;
    organizationId: string;
    actorId: string;
    kind: NotificationKind;
    ticketId: string;
    recipients: Iterable<string | null | undefined>;
    body: string;
  },
) {
  if (tx.location !== "server") return;
  const done = new Set<string>([n.actorId]);
  for (const userId of n.recipients) {
    if (!userId || done.has(userId)) continue;
    done.add(userId);
    if (!(await orgMembership(tx, userId, n.organizationId))) continue;
    if (!(await wantsNotification(tx, userId, n.organizationId, n.kind))) continue;
    await tx.mutate.notification.upsert({
      id: `${n.eventId}:${n.kind}:${userId}`,
      organizationId: n.organizationId,
      userId,
      actorId: n.actorId,
      kind: n.kind,
      ticketId: n.ticketId,
      messageId: null,
      channelId: null,
      docId: null,
      folderId: null,
      body: n.body,
      createdAt: Date.now(),
      readAt: null,
    });
  }
}

/** Authors of the messages a ticket was built from */
async function sourceAuthors(tx: Transaction, ticketId: string): Promise<string[]> {
  const rows = await tx.run(zql.ticketSource.where("ticketId", ticketId).related("message"));
  return rows.map((r) => r.message?.authorId).filter((a): a is string => !!a);
}

/** Loads a ticket with its project and the caller's role; server-side checks the role with `check` */
async function loadTicket(
  tx: Transaction,
  userID: string,
  organizationId: string,
  ticketId: string,
  check: (role: EffectiveProjectRole | null) => boolean,
  denied: string,
) {
  const ticket = await tx.run(zql.ticket.where("id", ticketId).where("organizationId", organizationId).related("project").one());
  if (tx.location === "server") {
    if (!ticket?.project) throw new PermissionError("Ticket not found or not accessible");
    const role = await projectRole(tx, userID, ticket.project);
    if (!check(role)) throw new PermissionError(denied);
  }
  return ticket;
}

/** Messages that can back a ticket: same organization, readable by the user, not deleted */
async function assertSourceMessages(tx: Transaction, userID: string, organizationId: string, messageIds: readonly string[]) {
  if (tx.location !== "server") return;
  for (const messageId of messageIds) {
    const msg = await tx.run(zql.message.where("id", messageId).where("organizationId", organizationId).one());
    if (!msg || msg.deletedAt) throw new PermissionError("Unknown message");
    await assertCanReadChannel(tx, userID, organizationId, msg.channelId);
  }
}

/** Links of `messageIds` to tickets other than `exceptTicketId` (server-side, authoritative) */
async function existingLinks(tx: Transaction, messageIds: readonly string[], exceptTicketId?: string) {
  if (!messageIds.length) return [];
  return sqlAll<{ messageId: string; ticketId: string }>(
    tx,
    `select message_id as "messageId", ticket_id as "ticketId" from ticket_source
      where message_id = any($1::text[]) and ($2::text is null or ticket_id <> $2::text)`,
    [messageIds, exceptTicketId ?? null],
  );
}

const alreadyLinked = (links: { messageId: string; ticketId: string }[]) =>
  new ApplicationError(alreadyLinkedMessage(links), { details: { code: ALREADY_LINKED, links } });

/** Next ticket number of a project (server: locked counter; client: provisional) */
async function nextNumber(tx: Transaction, projectId: string): Promise<number> {
  if (tx.location === "server") {
    const row = await sqlOne<{ n: number }>(
      tx,
      "update project set ticket_counter = ticket_counter + 1 where id = $1 returning ticket_counter as n",
      [projectId],
    );
    if (!row) throw new PermissionError("Unknown project");
    return Number(row.n);
  }
  const p = await tx.run(zql.project.where("id", projectId).one());
  const n = (p?.ticketCounter ?? 0) + 1;
  if (p) await tx.mutate.project.update({ id: projectId, ticketCounter: n });
  return n;
}

async function insertSources(
  tx: Transaction,
  s: { organizationId: string; ticketId: string; messageIds: readonly string[]; userID: string; at: number },
) {
  for (const messageId of new Set(s.messageIds)) {
    const existing = await tx.run(zql.ticketSource.where("ticketId", s.ticketId).where("messageId", messageId).one());
    if (existing) continue;
    await tx.mutate.ticketSource.insert({
      organizationId: s.organizationId,
      ticketId: s.ticketId,
      messageId,
      addedBy: s.userID,
      addedAt: s.at,
    });
    await mirrorTicketCount(tx, messageId, +1);
  }
}

/** message.ticket_count is maintained by a Postgres trigger; the client mirrors it optimistically */
async function mirrorTicketCount(tx: Transaction, messageId: string, delta: 1 | -1) {
  if (tx.location === "server") return;
  const m = await tx.run(zql.message.where("id", messageId).one());
  if (m) await tx.mutate.message.update({ id: messageId, ticketCount: Math.max(0, (m.ticketCount ?? 0) + delta) });
}

async function authorsOf(tx: Transaction, messageIds: readonly string[]) {
  const out: string[] = [];
  for (const messageId of messageIds) {
    const m = await tx.run(zql.message.where("id", messageId).one());
    if (m?.authorId) out.push(m.authorId);
  }
  return out;
}

async function assertAssignable(
  tx: Transaction,
  organizationId: string,
  project: { id: string; organizationId: string; visibility: string | null },
  userId: string,
) {
  if (tx.location !== "server") return;
  if (!(await projectRole(tx, userId, project))) throw new PermissionError("The assignee can't access this project");
  await assertOrgMember(tx, userId, organizationId);
}

async function assertLabels(tx: Transaction, organizationId: string, labelIds: readonly string[]) {
  if (tx.location !== "server") return;
  for (const labelId of labelIds) {
    if (!(await tx.run(zql.label.where("id", labelId).where("organizationId", organizationId).one())))
      throw new PermissionError("Unknown label");
  }
}

const statusArg = ticketStatus;
const priorityArg = ticketPriority;
const eventArgs = { organizationId: id, eventId: id, at: z.number() };

/* ------------------------------------------------------------------ */

export const projectMutators = {
  /** Organization owners and admins create projects; the creator becomes lead */
  create: defineMutator(
    z.object({
      id,
      organizationId: id,
      key: z.string().min(1).max(10),
      name: z.string().trim().min(1).max(80),
      color,
      visibility: projectVisibility,
      members: z
        .array(z.object({ userId: id, role: projectRoleEnum }))
        .max(500)
        .optional(),
      createdAt: z.number(),
    }),
    async ({ tx, ctx, args }) => {
      const key = normalizeProjectKey(args.key);
      if (!isValidProjectKey(key)) throw new Error("Invalid project key");
      if (tx.location === "server") {
        const m = await assertOrgMember(tx, ctx.userID, args.organizationId);
        if (!isOrgAdmin(m.role)) throw new PermissionError("Only owners and admins can create projects");
        const dup = await tx.run(zql.project.where("organizationId", args.organizationId).where("key", key).one());
        if (dup) throw new Error(`The key ${key} is already used`);
      }
      const when = at(tx, args.createdAt);
      await tx.mutate.project.insert({
        id: args.id,
        organizationId: args.organizationId,
        key,
        name: args.name,
        color: args.color,
        visibility: args.visibility,
        ticketCounter: 0,
        createdBy: ctx.userID,
        createdAt: when,
        archivedAt: null,
      });
      const members = new Map((args.members ?? []).map((m) => [m.userId, m.role] as const));
      members.set(ctx.userID, "lead");
      for (const [userId, role] of members) {
        if (tx.location === "server" && !(await orgMembership(tx, userId, args.organizationId))) continue;
        await tx.mutate.projectMember.upsert({
          id: `${args.id}:${userId}`,
          organizationId: args.organizationId,
          projectId: args.id,
          userId,
          role,
          createdAt: when,
        });
      }
    },
  ),

  /** Rename, recolor, change visibility (owners, admins, project leads). The key never changes. */
  update: defineMutator(
    z.object({
      organizationId: id,
      projectId: id,
      name: z.string().trim().min(1).max(80).optional(),
      color: color.optional(),
      visibility: projectVisibility.optional(),
    }),
    async ({ tx, ctx, args }) => {
      if (tx.location === "server") {
        const { role } = await assertProjectAccess(tx, ctx.userID, args.organizationId, args.projectId);
        if (!canManageProject(role)) throw new PermissionError("Only project leads and admins can edit the project");
      }
      await tx.mutate.project.update({ id: args.projectId, name: args.name, color: args.color, visibility: args.visibility });
    },
  ),

  /** Archive (read-only, hidden) or restore — owners and admins */
  archive: defineMutator(
    z.object({ organizationId: id, projectId: id, archived: z.boolean(), at: z.number() }),
    async ({ tx, ctx, args }) => {
      if (tx.location === "server") {
        const { role } = await assertProjectAccess(tx, ctx.userID, args.organizationId, args.projectId);
        if (role !== "admin") throw new PermissionError("Only owners and admins can archive a project");
      }
      await tx.mutate.project.update({ id: args.projectId, archivedAt: args.archived ? at(tx, args.at) : null });
    },
  ),

  /** Add a member or change their role (project leads, owners, admins) */
  setMember: defineMutator(
    z.object({ organizationId: id, projectId: id, userId: id, role: projectRoleEnum, at: z.number() }),
    async ({ tx, ctx, args }) => {
      if (tx.location === "server") {
        const { role } = await assertProjectAccess(tx, ctx.userID, args.organizationId, args.projectId);
        if (!canManageProject(role)) throw new PermissionError("Only project leads and admins can manage members");
        await assertOrgMember(tx, args.userId, args.organizationId);
      }
      const memberId = `${args.projectId}:${args.userId}`;
      const existing = await tx.run(zql.projectMember.where("id", memberId).one());
      if (existing) await tx.mutate.projectMember.update({ id: memberId, role: args.role });
      else
        await tx.mutate.projectMember.insert({
          id: memberId,
          organizationId: args.organizationId,
          projectId: args.projectId,
          userId: args.userId,
          role: args.role,
          createdAt: at(tx, args.at),
        });
    },
  ),

  removeMember: defineMutator(z.object({ organizationId: id, projectId: id, userId: id }), async ({ tx, ctx, args }) => {
    if (tx.location === "server") {
      const { role } = await assertProjectAccess(tx, ctx.userID, args.organizationId, args.projectId);
      if (!canManageProject(role)) throw new PermissionError("Only project leads and admins can manage members");
    }
    await tx.mutate.projectMember.delete({ id: `${args.projectId}:${args.userId}` });
  }),
};

/* ------------------------------------------------------------------ */

async function assertCanCreateLabels(tx: Transaction, userID: string, organizationId: string) {
  if (tx.location !== "server") return;
  const m = await assertOrgMember(tx, userID, organizationId);
  if (isOrgAdmin(m.role)) return;
  const writer = await tx.run(
    zql.projectMember.where("organizationId", organizationId).where("userId", userID).where("role", "IN", ["lead", "contributor"]).one(),
  );
  if (!writer) throw new PermissionError("Only people who can edit tickets can create labels");
}

async function assertAdmin(tx: Transaction, userID: string, organizationId: string, what: string) {
  if (tx.location !== "server") return;
  const m = await assertOrgMember(tx, userID, organizationId);
  if (!isOrgAdmin(m.role)) throw new PermissionError(`Only owners and admins can ${what}`);
}

export const labelMutators = {
  create: defineMutator(
    z.object({ id, organizationId: id, name: z.string().trim().min(1).max(40), color, createdAt: z.number() }),
    async ({ tx, ctx, args }) => {
      await assertCanCreateLabels(tx, ctx.userID, args.organizationId);
      if (tx.location === "server" && (await tx.run(zql.label.where("organizationId", args.organizationId).where("name", args.name).one())))
        throw new Error(`The label ${args.name} already exists`);
      await tx.mutate.label.insert({
        id: args.id,
        organizationId: args.organizationId,
        name: args.name,
        color: args.color,
        createdAt: at(tx, args.createdAt),
      });
    },
  ),
  update: defineMutator(
    z.object({ organizationId: id, id, name: z.string().trim().min(1).max(40).optional(), color: color.optional() }),
    async ({ tx, ctx, args }) => {
      await assertAdmin(tx, ctx.userID, args.organizationId, "edit labels");
      await tx.mutate.label.update({ id: args.id, name: args.name, color: args.color });
    },
  ),
  delete: defineMutator(z.object({ organizationId: id, id }), async ({ tx, ctx, args }) => {
    await assertAdmin(tx, ctx.userID, args.organizationId, "delete labels");
    await tx.mutate.label.delete({ id: args.id });
  }),
};

/* ------------------------------------------------------------------ */

export const ticketMutators = {
  /**
   * Creates a ticket, optionally from chat messages (`sourceMessageIds`).
   * Refuses messages already linked to another ticket unless `force` (ALREADY_LINKED error).
   */
  create: defineMutator(
    z.object({
      id,
      ...eventArgs,
      projectId: id,
      title: z.string().trim().min(1).max(300),
      description: z.string().max(50_000).default(""),
      status: statusArg,
      priority: priorityArg,
      assigneeId: id.nullable(),
      labelIds: z.array(id).max(20).default([]),
      sourceMessageIds: z.array(id).max(50).default([]),
      force: z.boolean().default(false),
    }),
    async ({ tx, ctx, args }) => {
      const when = at(tx, args.at);
      const project = await tx.run(zql.project.where("id", args.projectId).where("organizationId", args.organizationId).one());
      if (tx.location === "server") {
        const { role } = await assertProjectAccess(tx, ctx.userID, args.organizationId, args.projectId);
        if (!canEditTickets(role)) throw new PermissionError("You can't create tickets in this project");
        if (project?.archivedAt) throw new PermissionError("This project is archived");
        if (args.assigneeId && project) await assertAssignable(tx, args.organizationId, project, args.assigneeId);
        await assertLabels(tx, args.organizationId, args.labelIds);
        await assertSourceMessages(tx, ctx.userID, args.organizationId, args.sourceMessageIds);
        const links = await existingLinks(tx, args.sourceMessageIds);
        if (links.length && !args.force) throw alreadyLinked(links);
      }
      const number = await nextNumber(tx, args.projectId);
      await tx.mutate.ticket.insert({
        id: args.id,
        organizationId: args.organizationId,
        projectId: args.projectId,
        number,
        title: args.title,
        description: args.description,
        status: args.status,
        priority: args.priority,
        assigneeId: args.assigneeId,
        creatorId: ctx.userID,
        createdVia: tx.location === "server" ? (ctx.via ?? "app") : "app",
        createdAt: when,
        updatedAt: when,
        completedAt: isClosedStatus(args.status) ? when : null,
      });
      for (const labelId of new Set(args.labelIds))
        await tx.mutate.ticketLabel.upsert({ organizationId: args.organizationId, ticketId: args.id, labelId });
      await insertSources(tx, {
        organizationId: args.organizationId,
        ticketId: args.id,
        messageIds: args.sourceMessageIds,
        userID: ctx.userID,
        at: when,
      });

      const base = { eventId: args.eventId, organizationId: args.organizationId, ticketId: args.id, actorId: ctx.userID, at: when };
      await addActivity(tx, { ...base, kind: "created" });
      if (args.sourceMessageIds.length)
        await addActivity(tx, { ...base, kind: "linked_messages", to: String(new Set(args.sourceMessageIds).size) });

      const key = project ? ticketKey(project.key, number) : "";
      const body = `${key} ${args.title}`.trim();
      if (args.assigneeId) await notify(tx, { ...base, kind: "ticket_assigned", recipients: [args.assigneeId], body });
      if (args.sourceMessageIds.length)
        await notify(tx, { ...base, kind: "ticket_from_my_message", recipients: await authorsOf(tx, args.sourceMessageIds), body });
    },
  ),

  /** Edit properties (project leads, contributors, admins) */
  update: defineMutator(
    z.object({
      ...eventArgs,
      ticketId: id,
      title: z.string().trim().min(1).max(300).optional(),
      description: z.string().max(50_000).optional(),
      status: statusArg.optional(),
      priority: priorityArg.optional(),
      assigneeId: id.nullable().optional(),
    }),
    async ({ tx, ctx, args }) => {
      const t = await loadTicket(
        tx,
        ctx.userID,
        args.organizationId,
        args.ticketId,
        canEditTickets,
        "You can't edit tickets in this project",
      );
      if (!t) return;
      const when = at(tx, args.at);
      if (tx.location === "server" && args.assigneeId && t.project)
        await assertAssignable(tx, args.organizationId, t.project, args.assigneeId);

      const statusChanged = args.status !== undefined && args.status !== t.status;
      const priorityChanged = args.priority !== undefined && args.priority !== t.priority;
      const assigneeChanged = args.assigneeId !== undefined && args.assigneeId !== t.assigneeId;
      const titleChanged = args.title !== undefined && args.title !== t.title;
      const descriptionChanged = args.description !== undefined && args.description !== t.description;
      if (!statusChanged && !priorityChanged && !assigneeChanged && !titleChanged && !descriptionChanged) return;

      await tx.mutate.ticket.update({
        id: t.id,
        title: titleChanged ? args.title : undefined,
        description: descriptionChanged ? args.description : undefined,
        status: statusChanged ? args.status : undefined,
        priority: priorityChanged ? args.priority : undefined,
        assigneeId: assigneeChanged ? args.assigneeId : undefined,
        completedAt: statusChanged && args.status ? (isClosedStatus(args.status) ? when : null) : undefined,
        updatedAt: when,
      });

      const base = { eventId: args.eventId, organizationId: args.organizationId, ticketId: t.id, actorId: ctx.userID, at: when };
      const key = t.project ? ticketKey(t.project.key, t.number) : "";
      const body = `${key} ${args.title ?? t.title}`.trim();
      if (statusChanged) {
        await addActivity(tx, { ...base, kind: "status", from: t.status, to: args.status });
        await notify(tx, {
          ...base,
          kind: "ticket_status",
          recipients: [
            t.creatorId,
            args.assigneeId !== undefined ? args.assigneeId : t.assigneeId,
            ...(tx.location === "server" ? await sourceAuthors(tx, t.id) : []),
          ],
          body: `${body} → ${args.status}`,
        });
      }
      if (priorityChanged) await addActivity(tx, { ...base, kind: "priority", from: String(t.priority ?? 0), to: String(args.priority) });
      if (assigneeChanged) {
        await addActivity(tx, { ...base, kind: "assignee", from: t.assigneeId, to: args.assigneeId ?? null });
        if (args.assigneeId) await notify(tx, { ...base, kind: "ticket_assigned", recipients: [args.assigneeId], body });
      }
      if (titleChanged) await addActivity(tx, { ...base, kind: "title", from: t.title, to: args.title });
      if (descriptionChanged) await addActivity(tx, { ...base, kind: "description" });
    },
  ),

  /** Replace the labels of a ticket */
  setLabels: defineMutator(z.object({ ...eventArgs, ticketId: id, labelIds: z.array(id).max(20) }), async ({ tx, ctx, args }) => {
    const t = await loadTicket(
      tx,
      ctx.userID,
      args.organizationId,
      args.ticketId,
      canEditTickets,
      "You can't edit tickets in this project",
    );
    if (!t) return;
    await assertLabels(tx, args.organizationId, args.labelIds);
    const current = await tx.run(zql.ticketLabel.where("ticketId", t.id));
    const next = new Set(args.labelIds);
    const had = new Set(current.map((l) => l.labelId));
    let changed = false;
    for (const l of current)
      if (!next.has(l.labelId)) {
        await tx.mutate.ticketLabel.delete({ ticketId: t.id, labelId: l.labelId });
        changed = true;
      }
    for (const labelId of next)
      if (!had.has(labelId)) {
        await tx.mutate.ticketLabel.upsert({ organizationId: args.organizationId, ticketId: t.id, labelId });
        changed = true;
      }
    if (!changed) return;
    const when = at(tx, args.at);
    await tx.mutate.ticket.update({ id: t.id, updatedAt: when });
    await addActivity(tx, {
      eventId: args.eventId,
      organizationId: args.organizationId,
      ticketId: t.id,
      actorId: ctx.userID,
      kind: "labels",
      from: [...had].join(","),
      to: [...next].join(","),
      at: when,
    });
  }),

  /** Move to another project: new number there, the former key stays resolvable (ticket_alias) */
  move: defineMutator(z.object({ ...eventArgs, ticketId: id, projectId: id }), async ({ tx, ctx, args }) => {
    const t = await loadTicket(
      tx,
      ctx.userID,
      args.organizationId,
      args.ticketId,
      canEditTickets,
      "You can't edit tickets in this project",
    );
    if (!t || t.projectId === args.projectId) return;
    const target = await tx.run(zql.project.where("id", args.projectId).where("organizationId", args.organizationId).one());
    if (tx.location === "server") {
      const { role } = await assertProjectAccess(tx, ctx.userID, args.organizationId, args.projectId);
      if (!canEditTickets(role)) throw new PermissionError("You can't create tickets in the target project");
      if (target?.archivedAt) throw new PermissionError("The target project is archived");
    }
    const when = at(tx, args.at);
    await tx.mutate.ticketAlias.upsert({
      id: `${t.projectId}:${t.number}`,
      organizationId: args.organizationId,
      projectId: t.projectId,
      number: t.number,
      ticketId: t.id,
      createdAt: when,
    });
    const number = await nextNumber(tx, args.projectId);
    await tx.mutate.ticket.update({ id: t.id, projectId: args.projectId, number, updatedAt: when });
    await addActivity(tx, {
      eventId: args.eventId,
      organizationId: args.organizationId,
      ticketId: t.id,
      actorId: ctx.userID,
      kind: "project",
      from: t.project ? ticketKey(t.project.key, t.number) : null,
      to: target ? ticketKey(target.key, number) : null,
      at: when,
    });
  }),

  /** Link more chat messages to a ticket (e.g. a precision posted later) */
  linkMessages: defineMutator(
    z.object({ ...eventArgs, ticketId: id, messageIds: z.array(id).min(1).max(50), force: z.boolean().default(false) }),
    async ({ tx, ctx, args }) => {
      const t = await loadTicket(
        tx,
        ctx.userID,
        args.organizationId,
        args.ticketId,
        canEditTickets,
        "You can't edit tickets in this project",
      );
      if (!t) return;
      await assertSourceMessages(tx, ctx.userID, args.organizationId, args.messageIds);
      if (tx.location === "server") {
        const links = await existingLinks(tx, args.messageIds, t.id);
        if (links.length && !args.force) throw alreadyLinked(links);
      }
      const current = new Set((await tx.run(zql.ticketSource.where("ticketId", t.id))).map((s) => s.messageId));
      const fresh = [...new Set(args.messageIds)].filter((m) => !current.has(m));
      if (!fresh.length) return;
      const when = at(tx, args.at);
      await insertSources(tx, { organizationId: args.organizationId, ticketId: t.id, messageIds: fresh, userID: ctx.userID, at: when });
      await tx.mutate.ticket.update({ id: t.id, updatedAt: when });
      const base = { eventId: args.eventId, organizationId: args.organizationId, ticketId: t.id, actorId: ctx.userID, at: when };
      await addActivity(tx, { ...base, kind: "linked_messages", to: String(fresh.length) });
      const key = t.project ? ticketKey(t.project.key, t.number) : "";
      await notify(tx, {
        ...base,
        kind: "ticket_from_my_message",
        recipients: await authorsOf(tx, fresh),
        body: `${key} ${t.title}`.trim(),
      });
    },
  ),

  unlinkMessage: defineMutator(z.object({ ...eventArgs, ticketId: id, messageId: id }), async ({ tx, ctx, args }) => {
    const t = await loadTicket(
      tx,
      ctx.userID,
      args.organizationId,
      args.ticketId,
      canEditTickets,
      "You can't edit tickets in this project",
    );
    if (!t) return;
    const link = await tx.run(zql.ticketSource.where("ticketId", t.id).where("messageId", args.messageId).one());
    if (!link) return;
    const when = at(tx, args.at);
    await tx.mutate.ticketSource.delete({ ticketId: t.id, messageId: args.messageId });
    await mirrorTicketCount(tx, args.messageId, -1);
    await tx.mutate.ticket.update({ id: t.id, updatedAt: when });
    await addActivity(tx, {
      eventId: args.eventId,
      organizationId: args.organizationId,
      ticketId: t.id,
      actorId: ctx.userID,
      kind: "unlinked_messages",
      to: "1",
      at: when,
    });
  }),
};

/* ------------------------------------------------------------------ */

async function assertCanComment(tx: Transaction, userID: string, organizationId: string, ticketId: string) {
  const ticket = await tx.run(zql.ticket.where("id", ticketId).where("organizationId", organizationId).related("project").one());
  if (tx.location !== "server") return ticket;
  if (!ticket?.project) throw new PermissionError("Ticket not found or not accessible");
  const role = await projectRole(tx, userID, ticket.project);
  if (!canComment(role) && !(await isSourceAuthor(tx, userID, ticket.id))) throw new PermissionError("You can't comment on this ticket");
  return ticket;
}

async function assertCanReadTicket(tx: Transaction, userID: string, organizationId: string, ticketId: string) {
  if (tx.location !== "server") return;
  const ticket = await tx.run(zql.ticket.where("id", ticketId).where("organizationId", organizationId).related("project").one());
  if (!ticket?.project) throw new PermissionError("Ticket not found or not accessible");
  if (!(await projectRole(tx, userID, ticket.project)) && !(await isSourceAuthor(tx, userID, ticket.id)))
    throw new PermissionError("Ticket not found or not accessible");
}

export const commentMutators = {
  create: defineMutator(
    z.object({ id, organizationId: id, ticketId: id, body: z.string().trim().min(1).max(20_000), createdAt: z.number() }),
    async ({ tx, ctx, args }) => {
      const ticket = await assertCanComment(tx, ctx.userID, args.organizationId, args.ticketId);
      const when = at(tx, args.createdAt);
      await tx.mutate.comment.insert({
        id: args.id,
        organizationId: args.organizationId,
        ticketId: args.ticketId,
        authorId: ctx.userID,
        body: args.body,
        createdAt: when,
        editedAt: null,
      });
      if (tx.location !== "server" || !ticket?.project) return;
      const key = ticketKey(ticket.project.key, ticket.number);
      const base = { eventId: args.id, organizationId: args.organizationId, ticketId: ticket.id, actorId: ctx.userID };
      const mentioned: string[] = [];
      for (const userId of mentionedUserIds(args.body)) {
        // Only people who can read the ticket are notified
        if ((await projectRole(tx, userId, ticket.project)) || (await isSourceAuthor(tx, userId, ticket.id))) mentioned.push(userId);
      }
      await notify(tx, { ...base, kind: "mention", recipients: mentioned, body: `${key} · ${excerpt(args.body)}` });
      // Followers of the ticket: creator, assignee, authors of its source messages and previous commenters
      const commenters = await sqlAll<{ author_id: string }>(
        tx,
        "select distinct author_id from comment where ticket_id = $1 and id <> $2 and author_id is not null",
        [ticket.id, args.id],
      );
      const followers = [ticket.creatorId, ticket.assigneeId, ...(await sourceAuthors(tx, ticket.id))];
      for (const { author_id } of commenters) {
        // Former commenters may have lost access since (project made private, role removed)
        if ((await projectRole(tx, author_id, ticket.project)) || (await isSourceAuthor(tx, author_id, ticket.id)))
          followers.push(author_id);
      }
      await notify(tx, {
        ...base,
        kind: "comment",
        recipients: followers.filter((u) => u && !mentioned.includes(u)),
        body: `${key} · ${excerpt(args.body)}`,
      });
    },
  ),

  edit: defineMutator(
    z.object({ organizationId: id, id, body: z.string().trim().min(1).max(20_000), at: z.number() }),
    async ({ tx, ctx, args }) => {
      const c = await tx.run(zql.comment.where("id", args.id).where("organizationId", args.organizationId).one());
      if (!c) return;
      if (tx.location === "server" && c.authorId !== ctx.userID) throw new PermissionError("You can only edit your own comments");
      await tx.mutate.comment.update({ id: c.id, body: args.body, editedAt: at(tx, args.at) });
    },
  ),

  delete: defineMutator(z.object({ organizationId: id, id }), async ({ tx, ctx, args }) => {
    const c = await tx.run(zql.comment.where("id", args.id).where("organizationId", args.organizationId).one());
    if (!c) return;
    if (tx.location === "server" && c.authorId !== ctx.userID) {
      const m = await orgMembership(tx, ctx.userID, args.organizationId);
      if (!isOrgAdmin(m?.role)) throw new PermissionError("You can only delete your own comments");
    }
    await tx.mutate.comment.delete({ id: c.id });
  }),

  /** Emoji reactions on comments */
  react: defineMutator(z.object({ organizationId: id, commentId: id, emoji, at: z.number() }), async ({ tx, ctx, args }) => {
    const c = await tx.run(zql.comment.where("id", args.commentId).where("organizationId", args.organizationId).one());
    if (!c) return;
    await assertCanReadTicket(tx, ctx.userID, args.organizationId, c.ticketId);
    const reactionId = `c:${args.commentId}:${ctx.userID}:${args.emoji}`;
    if (await tx.run(zql.reaction.where("id", reactionId).one())) await tx.mutate.reaction.delete({ id: reactionId });
    else
      await tx.mutate.reaction.insert({
        id: reactionId,
        organizationId: args.organizationId,
        messageId: null,
        commentId: args.commentId,
        userId: ctx.userID,
        emoji: args.emoji,
        createdAt: at(tx, args.at),
      });
  }),
};
