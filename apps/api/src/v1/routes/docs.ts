/** /docs: knowledge base (tree, read, search, create, update with conflict detection) */
import { type AclRow, levelFor } from "@feedbacks/schema/docs";
import type { AccessLevel } from "@feedbacks/schema/enums";
import { newId } from "@feedbacks/schema/ids";
import { queries } from "@feedbacks/schema/zero/queries";
import { z } from "zod";
import { pool } from "../../db";
import { iso, limitParam, links, mutate, mutators, orgSlug, read, userNames } from "../common";
import { ApiError, notFound } from "../errors";
import { type Caller, defineRoute } from "../registry";
import { runSearch } from "./chat";

const level = z.enum(["read", "edit", "manage"]);

const folderOut = z.object({ id: z.string(), name: z.string(), parent_id: z.string().nullable(), level });
const docSummaryOut = z.object({
  id: z.string(),
  title: z.string(),
  folder_id: z.string().nullable(),
  version: z.number(),
  updated_at: z.string(),
  level,
  url: z.string(),
});
const docOut = docSummaryOut.extend({
  content: z.string().describe("Markdown of the current version"),
  updated_by: z.object({ id: z.string(), name: z.string() }).nullable(),
  path: z.array(z.string()).describe("Folder names from the root"),
});

const ctxOf = (caller: Caller) => ({ userID: caller.userId });

async function teamIds(caller: Caller) {
  const { rows } = await pool.query<{ team_id: string }>(
    "select tm.team_id from team_member tm join team t on t.id = tm.team_id where t.organization_id = $1 and tm.user_id = $2",
    [caller.organizationId, caller.userId],
  );
  return new Set(rows.map((r) => r.team_id));
}

async function tree(caller: Caller) {
  const args = { organizationId: caller.organizationId };
  const [folders, docs, teams] = await Promise.all([
    read(queries.docs.folders.fn({ args, ctx: ctxOf(caller) })),
    read(queries.docs.list.fn({ args, ctx: ctxOf(caller) })),
    teamIds(caller),
  ]);
  const admin = caller.role === "owner" || caller.role === "admin";
  const levelOf = (entries: readonly AclRow[]) => (levelFor(entries, caller.userId, teams, admin) ?? "read") as AccessLevel;
  return { folders, docs, levelOf };
}

async function readDoc(caller: Caller, docId: string) {
  const doc = await read(queries.docs.get.fn({ args: { organizationId: caller.organizationId, docId }, ctx: ctxOf(caller) }));
  if (!doc || doc.deletedAt) throw notFound("Document");
  const { folders, levelOf } = await tree(caller);
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path: string[] = [];
  for (let f = doc.folderId ? byId.get(doc.folderId) : undefined; f; f = f.parentId ? byId.get(f.parentId) : undefined)
    path.unshift(f.name);
  const names = await userNames(caller.organizationId, doc.updatedBy ? [doc.updatedBy] : []);
  const slug = await orgSlug(caller.organizationId);
  return {
    id: doc.id,
    title: doc.title,
    folder_id: doc.folderId,
    version: doc.version ?? 1,
    updated_at: iso(doc.updatedAt ?? 0) as string,
    level: levelOf(doc.aclEntries as readonly AclRow[]),
    url: links.doc(slug, doc.id),
    content: doc.versions[0]?.content ?? "",
    updated_by: doc.updatedBy ? { id: doc.updatedBy, name: names.get(doc.updatedBy) ?? "Former member" } : null,
    path,
  };
}

defineRoute({
  method: "get",
  path: "/docs/tree",
  operationId: "getDocsTree",
  tag: "Knowledge base",
  summary: "Folders and documents the caller can read, with their access level (no bodies)",
  response: z.object({ folders: z.array(folderOut), docs: z.array(docSummaryOut) }),
  handler: async ({ caller }) => {
    const { folders, docs, levelOf } = await tree(caller);
    const slug = await orgSlug(caller.organizationId);
    return {
      folders: folders.map((f) => ({ id: f.id, name: f.name, parent_id: f.parentId, level: levelOf(f.aclEntries as readonly AclRow[]) })),
      docs: docs.map((d) => ({
        id: d.id,
        title: d.title,
        folder_id: d.folderId,
        version: d.version ?? 1,
        updated_at: iso(d.updatedAt ?? 0) as string,
        level: levelOf(d.aclEntries as readonly AclRow[]),
        url: links.doc(slug, d.id),
      })),
    };
  },
});

defineRoute({
  method: "get",
  path: "/docs/search",
  operationId: "searchDocs",
  tag: "Knowledge base",
  summary: "Full-text search in the documents the caller can read (titles and bodies)",
  query: z.object({ q: z.string().trim().min(1).max(200), limit: limitParam(50, 20) }),
  response: z.object({
    data: z.array(z.object({ id: z.string(), title: z.string(), snippet: z.string(), url: z.string() })),
  }),
  handler: async ({ caller, query }) => {
    const results = await runSearch(caller, { q: query.q, types: ["doc"], limit: query.limit });
    return { data: results.map((r) => ({ id: r.id, title: r.title, snippet: r.snippet, url: r.url })) };
  },
});

defineRoute({
  method: "get",
  path: "/docs/:id",
  operationId: "getDoc",
  tag: "Knowledge base",
  summary: "One document with its markdown content and current version (use it as base_version to update)",
  params: z.object({ id: z.string().min(1).max(64) }),
  response: docOut,
  handler: async ({ caller, params }) => readDoc(caller, params.id),
});

defineRoute({
  method: "post",
  path: "/docs",
  operationId: "createDoc",
  tag: "Knowledge base",
  summary: "Create a document (edit access to the folder needed; root = every member)",
  body: z.object({
    title: z.string().trim().min(1).max(200),
    content: z.string().max(500_000).default(""),
    folder_id: z.string().min(1).max(64).nullable().optional(),
  }),
  response: docOut,
  status: 201,
  handler: async ({ caller, body }) => {
    const id = newId();
    await mutate(caller, mutators.docs.create, {
      id,
      organizationId: caller.organizationId,
      folderId: body.folder_id ?? null,
      title: body.title,
      content: body.content,
      sortOrder: Date.now(),
      versionId: newId(),
      at: Date.now(),
    });
    return readDoc(caller, id);
  },
});

defineRoute({
  method: "patch",
  path: "/docs/:id",
  operationId: "updateDoc",
  tag: "Knowledge base",
  summary: "Save a new version of a document (edit access needed)",
  description:
    "Pass the `version` you read as `base_version`: if someone saved in between, the save is refused with 409 " +
    "`doc_conflict` (details.currentVersion); re-read, merge, and retry — or pass `force: true` to overwrite. " +
    "Without `content`, only the title changes.",
  params: z.object({ id: z.string().min(1).max(64) }),
  body: z.object({
    title: z.string().trim().min(1).max(200).optional(),
    content: z.string().max(500_000).optional(),
    base_version: z.number().int().min(1).optional().describe("Required with `content`"),
    force: z.boolean().optional(),
  }),
  response: docOut,
  handler: async ({ caller, params, body }) => {
    const current = await readDoc(caller, params.id);
    if (body.content !== undefined && body.base_version === undefined && !body.force)
      throw new ApiError(400, "invalid_request", "`base_version` is required with `content` (or pass force: true)");
    if (body.content !== undefined) {
      await mutate(caller, mutators.docs.save, {
        organizationId: caller.organizationId,
        docId: params.id,
        title: body.title ?? current.title,
        content: body.content,
        baseVersion: body.base_version ?? current.version,
        force: body.force ?? false,
        versionId: newId(),
        at: Date.now(),
      });
    } else if (body.title !== undefined && body.title !== current.title) {
      await mutate(caller, mutators.docs.rename, {
        organizationId: caller.organizationId,
        docId: params.id,
        title: body.title,
        at: Date.now(),
      });
    }
    return readDoc(caller, params.id);
  },
});
