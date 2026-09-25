/**
 * Knowledge base: folders, documents, versions, trash, access grants, teams and document ↔ ticket links.
 *
 * - Permissions are checked on the server with the resolved ACL (`acl_entry`, maintained by triggers:
 *   see migration 0005 and `src/docs.ts`). Clients mirror new nodes' entries optimistically.
 * - Document bodies are written with SQL on the server (`doc.content` isn't synced); every save adds a
 *   `doc_version` row, which is also where clients read the current body from.
 * - Saves carry the version they were based on: a save based on an older version is refused with a
 *   DOC_CONFLICT error unless `force` (no CRDT: last explicit writer wins, nothing is silently merged).
 * - Subtree operations (trash, restore, purge) run as SQL on the server; clients update the item itself.
 */
import "./context";
import { ApplicationError, defineMutator, type Transaction } from "@rocicorp/zero";
import { z } from "zod";
import { type AclRow, aclId, atLeast, DOC_CONFLICT, docConflictMessage, LEVEL_RANK, maxLevel, resolveEntries } from "../docs";
import { type AccessLevel, accessLevel, principalType } from "../enums";
import { canEditTickets } from "../tickets";
import { wantsNotification } from "./mutators-notifications";
import {
  assertDocAccess,
  assertOrgMember,
  containerLevel,
  docNodeAccess,
  isOrgAdmin,
  orgMembership,
  PermissionError,
  projectRole,
} from "./permissions";
import { zql } from "./schema";

const id = z.string().min(1).max(64);
const nodeName = z.string().trim().min(1).max(200);
const body = z.string().max(500_000);
const at = (tx: Transaction, clientTime: number) => (tx.location === "server" ? Date.now() : clientTime);

async function sqlAll<T>(tx: Transaction, sql: string, params: unknown[]): Promise<T[]> {
  if (tx.location !== "server") return [];
  return [...(await tx.dbTransaction.query(sql, params))] as T[];
}

/** Folder or document, from the local store (client) or Postgres (server) */
async function findNode(tx: Transaction, organizationId: string, nodeId: string) {
  const [folder, doc] = await Promise.all([
    tx.run(zql.docFolder.where("id", nodeId).where("organizationId", organizationId).one()),
    tx.run(zql.doc.where("id", nodeId).where("organizationId", organizationId).one()),
  ]);
  if (folder) return { kind: "folder" as const, row: folder };
  if (doc) return { kind: "doc" as const, row: doc };
  return null;
}

/** Client-only: optimistic ACL entries of a new node (the server's come from the triggers) */
async function mirrorEntries(
  tx: Transaction,
  organizationId: string,
  node: { id: string; kind: "folder" | "doc" },
  parentId: string | null,
) {
  if (tx.location === "server") return;
  const parent: AclRow[] | null = parentId ? await tx.run(zql.aclEntry.where("nodeId", parentId)) : null;
  for (const e of resolveEntries([], parent, true))
    await tx.mutate.aclEntry.upsert({
      id: aclId(node.id, e.principalType, e.principalId),
      organizationId,
      nodeId: node.id,
      nodeKind: node.kind,
      principalType: e.principalType,
      principalId: e.principalId,
      level: e.level,
    });
}

async function assertCanWriteIn(tx: Transaction, userID: string, organizationId: string, folderId: string | null) {
  if (tx.location !== "server") return;
  if (!atLeast(await containerLevel(tx, userID, organizationId, folderId), "edit"))
    throw new PermissionError("You can't add or move items into this folder");
}

async function assertAdmin(tx: Transaction, userID: string, organizationId: string, what: string) {
  if (tx.location !== "server") return;
  const m = await assertOrgMember(tx, userID, organizationId);
  if (!isOrgAdmin(m.role)) throw new PermissionError(`Only owners and admins can ${what}`);
}

/* ------------------------------------------------------------------ */
/* Saving documents                                                    */
/* ------------------------------------------------------------------ */

async function saveDoc(
  tx: Transaction,
  userID: string,
  a: {
    organizationId: string;
    docId: string;
    title: string;
    content: string;
    baseVersion: number;
    force: boolean;
    versionId: string;
    at: number;
  },
) {
  const doc = await tx.run(zql.doc.where("id", a.docId).where("organizationId", a.organizationId).one());
  let current = doc?.version;
  if (tx.location === "server") {
    const access = await assertDocAccess(tx, userID, a.organizationId, a.docId, "edit");
    if (access.row.deletedAt) throw new PermissionError("This document is in the trash");
    // Row lock: concurrent saves of the same document are serialized, so the version check is exact
    const [row] = await sqlAll<{ version: number }>(tx, "select version from doc where id = $1 for update", [a.docId]);
    current = row?.version;
  }
  if (!doc || current == null) return;
  // Server only: clients re-run pending mutators on every sync (rebase), where a local check would fail
  // spuriously; they apply optimistically and learn about conflicts from the server result.
  if (tx.location === "server" && current !== a.baseVersion && !a.force)
    throw new ApplicationError(docConflictMessage(current), { details: { code: DOC_CONFLICT, currentVersion: current } });
  const number = current + 1;
  const when = at(tx, a.at);
  await tx.mutate.doc.update({ id: a.docId, title: a.title, version: number, updatedBy: userID, updatedAt: when });
  if (tx.location === "server") await tx.dbTransaction.query("update doc set content = $1 where id = $2", [a.content, a.docId]);
  await tx.mutate.docVersion.insert({
    id: a.versionId,
    organizationId: a.organizationId,
    docId: a.docId,
    number,
    title: a.title,
    content: a.content,
    authorId: userID,
    createdAt: when,
  });
}

/* ------------------------------------------------------------------ */

export const folderMutators = {
  create: defineMutator(
    z.object({ id, organizationId: id, parentId: id.nullable(), name: nodeName, sortOrder: z.number(), at: z.number() }),
    async ({ tx, ctx, args }) => {
      await assertCanWriteIn(tx, ctx.userID, args.organizationId, args.parentId);
      const when = at(tx, args.at);
      await tx.mutate.docFolder.insert({
        id: args.id,
        organizationId: args.organizationId,
        parentId: args.parentId,
        name: args.name,
        inheritGrants: true,
        sortOrder: args.sortOrder,
        createdBy: ctx.userID,
        createdAt: when,
        updatedAt: when,
        deletedAt: null,
        deletedBy: null,
        trashRootId: null,
      });
      await mirrorEntries(tx, args.organizationId, { id: args.id, kind: "folder" }, args.parentId);
    },
  ),

  rename: defineMutator(z.object({ organizationId: id, folderId: id, name: nodeName, at: z.number() }), async ({ tx, ctx, args }) => {
    if (tx.location === "server") {
      const a = await assertDocAccess(tx, ctx.userID, args.organizationId, args.folderId, "edit");
      if (a.kind !== "folder") throw new PermissionError("Not a folder");
    }
    await tx.mutate.docFolder.update({ id: args.folderId, name: args.name, updatedAt: at(tx, args.at) });
  }),

  /** Moves a folder (and everything in it) under another folder, or to the root */
  move: defineMutator(
    z.object({ organizationId: id, folderId: id, parentId: id.nullable(), sortOrder: z.number(), at: z.number() }),
    async ({ tx, ctx, args }) => {
      if (tx.location === "server") {
        const a = await assertDocAccess(tx, ctx.userID, args.organizationId, args.folderId, "edit");
        if (a.kind !== "folder") throw new PermissionError("Not a folder");
        await assertCanWriteIn(tx, ctx.userID, args.organizationId, args.parentId);
        // No cycles: the destination can't be the folder itself or one of its descendants
        let cursor = args.parentId;
        for (let depth = 0; cursor && depth < 100; depth++) {
          if (cursor === args.folderId) throw new PermissionError("A folder can't be moved inside itself");
          const parent = await tx.run(zql.docFolder.where("id", cursor).one());
          cursor = parent?.parentId ?? null;
        }
      }
      await tx.mutate.docFolder.update({
        id: args.folderId,
        parentId: args.parentId,
        sortOrder: args.sortOrder,
        updatedAt: at(tx, args.at),
      });
    },
  ),
};

export const docMutators = {
  create: defineMutator(
    z.object({
      id,
      organizationId: id,
      folderId: id.nullable(),
      title: nodeName,
      content: body,
      sortOrder: z.number(),
      versionId: id,
      at: z.number(),
    }),
    async ({ tx, ctx, args }) => {
      await assertCanWriteIn(tx, ctx.userID, args.organizationId, args.folderId);
      const when = at(tx, args.at);
      await tx.mutate.doc.insert({
        id: args.id,
        organizationId: args.organizationId,
        folderId: args.folderId,
        title: args.title,
        version: 1,
        inheritGrants: true,
        sortOrder: args.sortOrder,
        source: null,
        createdBy: ctx.userID,
        createdAt: when,
        updatedBy: ctx.userID,
        updatedAt: when,
        deletedAt: null,
        deletedBy: null,
        trashRootId: null,
      });
      if (tx.location === "server") await tx.dbTransaction.query("update doc set content = $1 where id = $2", [args.content, args.id]);
      await tx.mutate.docVersion.insert({
        id: args.versionId,
        organizationId: args.organizationId,
        docId: args.id,
        number: 1,
        title: args.title,
        content: args.content,
        authorId: ctx.userID,
        createdAt: when,
      });
      await mirrorEntries(tx, args.organizationId, { id: args.id, kind: "doc" }, args.folderId);
    },
  ),

  /** Saves a new version. `baseVersion` = the version the editor started from (conflict detection) */
  save: defineMutator(
    z.object({
      organizationId: id,
      docId: id,
      title: nodeName,
      content: body,
      baseVersion: z.number().int().min(1),
      force: z.boolean().default(false),
      versionId: id,
      at: z.number(),
    }),
    async ({ tx, ctx, args }) => saveDoc(tx, ctx.userID, args),
  ),

  /** Restores an older version by saving its content as a new version */
  restoreVersion: defineMutator(
    z.object({ organizationId: id, docId: id, fromVersionId: id, baseVersion: z.number().int().min(1), versionId: id, at: z.number() }),
    async ({ tx, ctx, args }) => {
      const src = await tx.run(zql.docVersion.where("id", args.fromVersionId).where("docId", args.docId).one());
      if (!src) {
        if (tx.location === "server") throw new PermissionError("Version not found");
        return;
      }
      await saveDoc(tx, ctx.userID, {
        organizationId: args.organizationId,
        docId: args.docId,
        title: src.title,
        content: src.content,
        baseVersion: args.baseVersion,
        force: false,
        versionId: args.versionId,
        at: args.at,
      });
    },
  ),

  rename: defineMutator(z.object({ organizationId: id, docId: id, title: nodeName, at: z.number() }), async ({ tx, ctx, args }) => {
    if (tx.location === "server") {
      const a = await assertDocAccess(tx, ctx.userID, args.organizationId, args.docId, "edit");
      if (a.kind !== "doc") throw new PermissionError("Not a document");
    }
    await tx.mutate.doc.update({ id: args.docId, title: args.title, updatedBy: ctx.userID, updatedAt: at(tx, args.at) });
  }),

  move: defineMutator(
    z.object({ organizationId: id, docId: id, folderId: id.nullable(), sortOrder: z.number(), at: z.number() }),
    async ({ tx, ctx, args }) => {
      if (tx.location === "server") {
        const a = await assertDocAccess(tx, ctx.userID, args.organizationId, args.docId, "edit");
        if (a.kind !== "doc") throw new PermissionError("Not a document");
        await assertCanWriteIn(tx, ctx.userID, args.organizationId, args.folderId);
      }
      await tx.mutate.doc.update({ id: args.docId, folderId: args.folderId, sortOrder: args.sortOrder, updatedAt: at(tx, args.at) });
    },
  ),
};

/* ------------------------------------------------------------------ */
/* Trash                                                               */
/* ------------------------------------------------------------------ */

const SUBTREE = `with recursive sub as (
    select f.id from doc_folder f where f.parent_id = $1
    union all
    select f.id from doc_folder f join sub on f.parent_id = sub.id
  )`;

export const trashMutators = {
  /** Moves a folder (with everything in it) or a document to the trash */
  delete: defineMutator(z.object({ organizationId: id, nodeId: id, at: z.number() }), async ({ tx, ctx, args }) => {
    const node = await findNode(tx, args.organizationId, args.nodeId);
    if (tx.location === "server") await assertDocAccess(tx, ctx.userID, args.organizationId, args.nodeId, "edit");
    if (!node || node.row.deletedAt) return;
    const when = at(tx, args.at);
    if (node.kind === "folder") {
      if (tx.location === "server") {
        const params = [args.nodeId, new Date(when), ctx.userID];
        await tx.dbTransaction.query(
          `${SUBTREE} update doc_folder set deleted_at = $2, deleted_by = $3, trash_root_id = $1
            where id in (select id from sub) and deleted_at is null`,
          params,
        );
        await tx.dbTransaction.query(
          `${SUBTREE} update doc set deleted_at = $2, deleted_by = $3, trash_root_id = $1
            where deleted_at is null and (folder_id = $1 or folder_id in (select id from sub))`,
          params,
        );
      }
      await tx.mutate.docFolder.update({ id: args.nodeId, deletedAt: when, deletedBy: ctx.userID, trashRootId: null });
    } else {
      await tx.mutate.doc.update({ id: args.nodeId, deletedAt: when, deletedBy: ctx.userID, trashRootId: null });
    }
  }),

  /** Restores an item deleted by someone (and what was trashed with it). Its parent gone? Back to the root. */
  restore: defineMutator(z.object({ organizationId: id, nodeId: id, at: z.number() }), async ({ tx, ctx, args }) => {
    const node = await findNode(tx, args.organizationId, args.nodeId);
    if (tx.location === "server") {
      await assertDocAccess(tx, ctx.userID, args.organizationId, args.nodeId, "edit");
      if (!node?.row.deletedAt || node.row.trashRootId) throw new PermissionError("Not in the trash");
      await tx.dbTransaction.query(
        "update doc_folder set deleted_at = null, deleted_by = null, trash_root_id = null where trash_root_id = $1",
        [args.nodeId],
      );
      await tx.dbTransaction.query("update doc set deleted_at = null, deleted_by = null, trash_root_id = null where trash_root_id = $1", [
        args.nodeId,
      ]);
    }
    if (!node) return;
    const parentId = node.kind === "folder" ? node.row.parentId : node.row.folderId;
    const parent = parentId ? await tx.run(zql.docFolder.where("id", parentId).one()) : null;
    const orphan = !!parentId && (!parent || !!parent.deletedAt);
    const when = at(tx, args.at);
    if (node.kind === "folder")
      await tx.mutate.docFolder.update({
        id: args.nodeId,
        deletedAt: null,
        deletedBy: null,
        trashRootId: null,
        updatedAt: when,
        ...(orphan ? { parentId: null } : {}),
      });
    else
      await tx.mutate.doc.update({
        id: args.nodeId,
        deletedAt: null,
        deletedBy: null,
        trashRootId: null,
        ...(orphan ? { folderId: null } : {}),
      });
  }),

  /** Deletes a trashed item and everything trashed with it for good (owners and admins) */
  purge: defineMutator(z.object({ organizationId: id, nodeId: id }), async ({ tx, ctx, args }) => {
    await assertAdmin(tx, ctx.userID, args.organizationId, "empty the trash");
    const node = await findNode(tx, args.organizationId, args.nodeId);
    if (!node) return;
    if (tx.location === "server") {
      if (!node.row.deletedAt || node.row.trashRootId) throw new PermissionError("Only items in the trash can be deleted for good");
      // Documents first (their attachments cascade and their files are queued for deletion)
      await tx.dbTransaction.query("delete from doc where organization_id = $2 and (trash_root_id = $1 or id = $1)", [
        args.nodeId,
        args.organizationId,
      ]);
      await tx.dbTransaction.query("delete from doc_folder where organization_id = $2 and (trash_root_id = $1 or id = $1)", [
        args.nodeId,
        args.organizationId,
      ]);
      return;
    }
    if (node.kind === "folder") await tx.mutate.docFolder.delete({ id: args.nodeId });
    else await tx.mutate.doc.delete({ id: args.nodeId });
  }),
};

/* ------------------------------------------------------------------ */
/* Access                                                              */
/* ------------------------------------------------------------------ */

async function assertPrincipal(tx: Transaction, organizationId: string, type: "org" | "team" | "user", principalId: string | null) {
  if (tx.location !== "server") return;
  if (type === "org") {
    if (principalId) throw new PermissionError("An organization grant has no principal id");
    return;
  }
  if (!principalId) throw new PermissionError("Missing principal");
  if (type === "user" && !(await orgMembership(tx, principalId, organizationId)))
    throw new PermissionError("Not a member of this organization");
  if (type === "team" && !(await tx.run(zql.team.where("id", principalId).where("organizationId", organizationId).one())))
    throw new PermissionError("Unknown team");
}

async function upsertGrant(
  tx: Transaction,
  g: {
    organizationId: string;
    nodeId: string;
    kind: "folder" | "doc";
    principalType: "org" | "team" | "user";
    principalId: string | null;
    level: AccessLevel;
    by: string;
    at: number;
  },
) {
  await tx.mutate.accessGrant.upsert({
    id: aclId(g.nodeId, g.principalType, g.principalId),
    organizationId: g.organizationId,
    nodeId: g.nodeId,
    folderId: g.kind === "folder" ? g.nodeId : null,
    docId: g.kind === "doc" ? g.nodeId : null,
    principalType: g.principalType,
    principalId: g.principalId,
    level: g.level,
    createdBy: g.by,
    createdAt: g.at,
  });
}

export const accessMutators = {
  /** Adds or changes a grant on a node (manage access needed) */
  grant: defineMutator(
    z.object({
      organizationId: id,
      nodeId: id,
      principalType,
      principalId: id.nullable(),
      level: accessLevel,
      at: z.number(),
    }),
    async ({ tx, ctx, args }) => {
      if (tx.location === "server") await assertDocAccess(tx, ctx.userID, args.organizationId, args.nodeId, "manage");
      await assertPrincipal(tx, args.organizationId, args.principalType, args.principalId);
      const node = await findNode(tx, args.organizationId, args.nodeId);
      if (!node) return;
      await upsertGrant(tx, { ...args, kind: node.kind, by: ctx.userID, at: at(tx, args.at) });
    },
  ),

  revoke: defineMutator(z.object({ organizationId: id, grantId: z.string().min(1).max(200) }), async ({ tx, ctx, args }) => {
    const g = await tx.run(zql.accessGrant.where("id", args.grantId).where("organizationId", args.organizationId).one());
    if (!g) return;
    if (tx.location === "server") await assertDocAccess(tx, ctx.userID, args.organizationId, g.nodeId, "manage");
    await tx.mutate.accessGrant.delete({ id: args.grantId });
  }),

  /**
   * Restricts a node (stops inheriting: only its own grants apply) or makes it inherit again.
   * Restricting keeps everyone's current access by copying the inherited entries into grants, and
   * keeps the person restricting as a manager: nothing changes until grants are edited.
   */
  setInherit: defineMutator(
    z.object({ organizationId: id, nodeId: id, inherit: z.boolean(), at: z.number() }),
    async ({ tx, ctx, args }) => {
      const node = await findNode(tx, args.organizationId, args.nodeId);
      if (tx.location === "server") await assertDocAccess(tx, ctx.userID, args.organizationId, args.nodeId, "manage");
      if (!node || node.row.inheritGrants === args.inherit) return;
      const when = at(tx, args.at);
      if (!args.inherit && tx.location === "server") {
        const [entries, own, member] = await Promise.all([
          tx.run(zql.aclEntry.where("nodeId", args.nodeId)),
          tx.run(zql.accessGrant.where("nodeId", args.nodeId)),
          orgMembership(tx, ctx.userID, args.organizationId),
        ]);
        const ownLevel = new Map(own.map((g) => [aclId(g.nodeId, g.principalType, g.principalId), g.level]));
        for (const e of entries) {
          const key = aclId(args.nodeId, e.principalType, e.principalId);
          const prev = ownLevel.get(key) ?? null;
          if (prev && LEVEL_RANK[prev] >= LEVEL_RANK[e.level]) continue;
          await upsertGrant(tx, {
            ...args,
            kind: node.kind,
            principalType: e.principalType,
            principalId: e.principalId,
            level: e.level,
            by: ctx.userID,
            at: when,
          });
        }
        if (!isOrgAdmin(member?.role))
          await upsertGrant(tx, {
            ...args,
            kind: node.kind,
            principalType: "user",
            principalId: ctx.userID,
            level: "manage",
            by: ctx.userID,
            at: when,
          });
      }
      if (node.kind === "folder") await tx.mutate.docFolder.update({ id: args.nodeId, inheritGrants: args.inherit, updatedAt: when });
      else await tx.mutate.doc.update({ id: args.nodeId, inheritGrants: args.inherit });
    },
  ),

  /** Asks the people who manage a node for access (they get an `access_request` notification) */
  request: defineMutator(
    z.object({ organizationId: id, nodeId: id, level: accessLevel, eventId: id, at: z.number() }),
    async ({ tx, ctx, args }) => {
      if (tx.location !== "server") return; // nothing to show locally: the requester can't see the node
      await assertOrgMember(tx, ctx.userID, args.organizationId);
      const a = await docNodeAccess(tx, ctx.userID, args.organizationId, args.nodeId);
      if (!a) throw new PermissionError("Document not found or not accessible");
      if (atLeast(a.level, args.level)) return;
      const managers = await sqlAll<{ user_id: string }>(
        tx,
        `select distinct user_id from (
           select m.user_id from member m where m.organization_id = $1 and m.role in ('owner', 'admin')
           union
           select e.principal_id from acl_entry e where e.node_id = $2 and e.level = 'manage' and e.principal_type = 'user'
           union
           select tm.user_id from acl_entry e join team_member tm on tm.team_id = e.principal_id
            where e.node_id = $2 and e.level = 'manage' and e.principal_type = 'team'
         ) x where user_id is not null and user_id <> $3 limit 20`,
        [args.organizationId, args.nodeId, ctx.userID],
      );
      for (const { user_id: userId } of managers) {
        if (!(await orgMembership(tx, userId, args.organizationId))) continue;
        if (!(await wantsNotification(tx, userId, args.organizationId, "access_request"))) continue;
        await tx.mutate.notification.upsert({
          id: `${args.eventId}:access_request:${userId}`,
          organizationId: args.organizationId,
          userId,
          actorId: ctx.userID,
          kind: "access_request",
          ticketId: null,
          messageId: null,
          channelId: null,
          docId: a.kind === "doc" ? args.nodeId : null,
          folderId: a.kind === "folder" ? args.nodeId : null,
          body: args.level,
          createdAt: Date.now(),
          readAt: null,
        });
      }
    },
  ),

  /** Grants what was asked from an `access_request` notification (manage access needed) */
  grantRequest: defineMutator(
    z.object({ organizationId: id, notificationId: z.string().min(1).max(200), level: accessLevel, at: z.number() }),
    async ({ tx, ctx, args }) => {
      const n = await tx.run(zql.notification.where("id", args.notificationId).one());
      if (!n || n.userId !== ctx.userID || n.kind !== "access_request") {
        if (tx.location === "server") throw new PermissionError("Not your request");
        return;
      }
      const nodeId = n.docId ?? n.folderId;
      const when = at(tx, args.at);
      if (tx.location === "server") {
        if (!nodeId || !n.actorId) throw new PermissionError("Invalid request");
        const a = await assertDocAccess(tx, ctx.userID, args.organizationId, nodeId, "manage");
        const existing = await tx.run(zql.accessGrant.where("id", aclId(nodeId, "user", n.actorId)).one());
        await upsertGrant(tx, {
          organizationId: args.organizationId,
          nodeId,
          kind: a.kind,
          principalType: "user",
          principalId: n.actorId,
          level: maxLevel(existing?.level ?? null, args.level) as AccessLevel,
          by: ctx.userID,
          at: when,
        });
      }
      await tx.mutate.notification.update({ id: n.id, readAt: n.readAt ?? when });
    },
  ),
};

/* ------------------------------------------------------------------ */
/* Teams                                                               */
/* ------------------------------------------------------------------ */

const teamName = z.string().trim().min(1).max(60);

async function assertTeam(tx: Transaction, organizationId: string, teamId: string) {
  const t = await tx.run(zql.team.where("id", teamId).where("organizationId", organizationId).one());
  if (!t && tx.location === "server") throw new PermissionError("Unknown team");
  return t;
}

async function syncMemberCount(tx: Transaction, teamId: string) {
  if (tx.location !== "server") return;
  await tx.dbTransaction.query("update team set member_count = (select count(*) from team_member where team_id = $1) where id = $1", [
    teamId,
  ]);
}

export const teamMutators = {
  create: defineMutator(z.object({ id, organizationId: id, name: teamName, at: z.number() }), async ({ tx, ctx, args }) => {
    await assertAdmin(tx, ctx.userID, args.organizationId, "manage teams");
    const when = at(tx, args.at);
    await tx.mutate.team.insert({
      id: args.id,
      organizationId: args.organizationId,
      name: args.name,
      memberCount: 0,
      createdAt: when,
      updatedAt: when,
    });
  }),

  rename: defineMutator(z.object({ organizationId: id, teamId: id, name: teamName, at: z.number() }), async ({ tx, ctx, args }) => {
    await assertAdmin(tx, ctx.userID, args.organizationId, "manage teams");
    if (!(await assertTeam(tx, args.organizationId, args.teamId))) return;
    await tx.mutate.team.update({ id: args.teamId, name: args.name, updatedAt: at(tx, args.at) });
  }),

  /** Deletes a team; its document grants go with it (access is recomputed) */
  delete: defineMutator(z.object({ organizationId: id, teamId: id }), async ({ tx, ctx, args }) => {
    await assertAdmin(tx, ctx.userID, args.organizationId, "manage teams");
    if (!(await assertTeam(tx, args.organizationId, args.teamId))) return;
    if (tx.location === "server")
      await tx.dbTransaction.query("delete from access_grant where principal_type = 'team' and principal_id = $1", [args.teamId]);
    await tx.mutate.team.delete({ id: args.teamId });
  }),

  addMember: defineMutator(z.object({ organizationId: id, teamId: id, userId: id, at: z.number() }), async ({ tx, ctx, args }) => {
    await assertAdmin(tx, ctx.userID, args.organizationId, "manage teams");
    if (!(await assertTeam(tx, args.organizationId, args.teamId))) return;
    if (tx.location === "server" && !(await orgMembership(tx, args.userId, args.organizationId)))
      throw new PermissionError("Not a member of this organization");
    await tx.mutate.teamMember.upsert({
      id: `${args.teamId}:${args.userId}`,
      teamId: args.teamId,
      userId: args.userId,
      membershipKey: null,
      createdAt: at(tx, args.at),
    });
    await syncMemberCount(tx, args.teamId);
  }),

  removeMember: defineMutator(z.object({ organizationId: id, teamId: id, userId: id }), async ({ tx, ctx, args }) => {
    await assertAdmin(tx, ctx.userID, args.organizationId, "manage teams");
    if (!(await assertTeam(tx, args.organizationId, args.teamId))) return;
    const rows = await tx.run(zql.teamMember.where("teamId", args.teamId).where("userId", args.userId));
    for (const r of rows) await tx.mutate.teamMember.delete({ id: r.id });
    await syncMemberCount(tx, args.teamId);
  }),
};

/* ------------------------------------------------------------------ */
/* Documents ↔ tickets                                                 */
/* ------------------------------------------------------------------ */

async function assertCanEditTicket(tx: Transaction, userID: string, organizationId: string, ticketId: string) {
  if (tx.location !== "server") return;
  const ticket = await tx.run(zql.ticket.where("id", ticketId).where("organizationId", organizationId).related("project").one());
  if (!ticket?.project) throw new PermissionError("Ticket not found or not accessible");
  if (!canEditTickets(await projectRole(tx, userID, ticket.project))) throw new PermissionError("You can't edit this ticket");
}

export const docLinkMutators = {
  link: defineMutator(z.object({ organizationId: id, ticketId: id, docId: id, at: z.number() }), async ({ tx, ctx, args }) => {
    await assertCanEditTicket(tx, ctx.userID, args.organizationId, args.ticketId);
    if (tx.location === "server") await assertDocAccess(tx, ctx.userID, args.organizationId, args.docId, "read");
    await tx.mutate.docLink.upsert({
      id: `${args.ticketId}:${args.docId}`,
      organizationId: args.organizationId,
      ticketId: args.ticketId,
      docId: args.docId,
      createdBy: ctx.userID,
      createdAt: at(tx, args.at),
    });
  }),

  unlink: defineMutator(z.object({ organizationId: id, ticketId: id, docId: id }), async ({ tx, ctx, args }) => {
    await assertCanEditTicket(tx, ctx.userID, args.organizationId, args.ticketId);
    const link = await tx.run(zql.docLink.where("id", `${args.ticketId}:${args.docId}`).one());
    if (link) await tx.mutate.docLink.delete({ id: link.id });
  }),
};
