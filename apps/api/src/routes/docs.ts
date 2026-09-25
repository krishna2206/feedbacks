/**
 * Knowledge base endpoints that don't fit sync:
 *
 *   GET  /api/docs/node/:id?organizationId=…   What a user may know about a folder/document they may not
 *                                               be able to read (shared links → "request access" page):
 *                                               its kind and the user's level; the title only when readable.
 *   POST /api/docs/import                       multipart: file (.zip of markdown, or one .md), organizationId,
 *                                               [folderId], [dryRun=1]. Recreates folders and documents under
 *                                               the target folder (edit access needed) and returns a report.
 *
 * Import is the first step towards importing from Google Drive (Docs exported as markdown): the app is the
 * source of truth once imported. Writes go straight to Postgres in one transaction; triggers resolve the
 * access entries and the search index, and zero-cache syncs the result.
 */

import { titleFromMarkdown } from "@feedbacks/schema/docs";
import { newId } from "@feedbacks/schema/ids";
import { unzipSync } from "fflate";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { auth } from "../auth";
import { pool } from "../db";

const IMPORT_MAX_BYTES = 50 * 1024 * 1024;
const IMPORT_MAX_FILES = 2000;
const IMPORT_MAX_UNZIPPED = 100 * 1024 * 1024;
const MARKDOWN = /\.(md|markdown|txt)$/i;

async function userFrom(c: Context) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

async function orgRole(userId: string, organizationId: string) {
  const { rows } = await pool.query<{ role: string }>("select role from member where organization_id = $1 and user_id = $2", [
    organizationId,
    userId,
  ]);
  return rows[0]?.role ?? null;
}

export type ImportReport = {
  dryRun: boolean;
  folders: { created: number; reused: number };
  docs: { path: string; title: string }[];
  warnings: { path: string; message: string }[];
  failures: { path: string; message: string }[];
};

type ImportFile = { path: string; data: Uint8Array };

/** Normalized entries of the upload: markdown files with their folder path, others reported */
function readUpload(name: string, bytes: Uint8Array, report: ImportReport): ImportFile[] {
  if (!/\.zip$/i.test(name)) {
    if (!MARKDOWN.test(name)) {
      report.failures.push({ path: name, message: "Only .zip archives and markdown files (.md) can be imported" });
      return [];
    }
    return [{ path: name, data: bytes }];
  }
  let total = 0;
  let count = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        count++;
        total += f.originalSize;
        return count <= IMPORT_MAX_FILES && total <= IMPORT_MAX_UNZIPPED && !f.name.endsWith("/");
      },
    });
  } catch (e) {
    report.failures.push({ path: name, message: `Unreadable archive: ${(e as Error).message}` });
    return [];
  }
  if (count > IMPORT_MAX_FILES) report.warnings.push({ path: name, message: `Only the first ${IMPORT_MAX_FILES} entries were read` });
  if (total > IMPORT_MAX_UNZIPPED)
    report.warnings.push({ path: name, message: "The archive is too large once unpacked: it was partly read" });
  const out: ImportFile[] = [];
  for (const [raw, data] of Object.entries(files)) {
    const path = raw.replace(/\\/g, "/").replace(/^(\.\/|\/)+/, "");
    const parts = path.split("/");
    if (!path || parts.some((p) => p === ".." || p.startsWith(".")) || parts[0] === "__MACOSX") continue; // hidden/system files
    if (!MARKDOWN.test(path)) {
      report.warnings.push({ path, message: "Skipped: not a markdown file (images and other files aren't imported yet)" });
      continue;
    }
    out.push({ path, data });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

async function importDocs(c: Context) {
  const user = await userFrom(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const form = await c.req.parseBody();
  const file = form.file;
  const organizationId = String(form.organizationId ?? "");
  const targetId = String(form.folderId ?? "") || null;
  const dryRun = form.dryRun === "1" || form.dryRun === "true";
  if (!(file instanceof File) || !organizationId) return c.json({ error: "bad_request" }, 400);
  const role = await orgRole(user.id, organizationId);
  if (!role) return c.json({ error: "forbidden" }, 403);

  // Edit access on the target folder (root: every member can edit, see DEFAULT_ROOT_LEVEL)
  if (targetId) {
    const { rows } = await pool.query<{ level: number }>(
      "select doc_access_level($1, f.id) as level from doc_folder f where f.id = $2 and f.organization_id = $3 and f.deleted_at is null",
      [user.id, targetId, organizationId],
    );
    if (Number(rows[0]?.level ?? 0) < 2) return c.json({ error: "forbidden" }, 403);
  }

  const report: ImportReport = { dryRun, folders: { created: 0, reused: 0 }, docs: [], warnings: [], failures: [] };
  const entries = readUpload(file.name, new Uint8Array(await file.arrayBuffer()), report);
  const decoder = new TextDecoder("utf-8", { fatal: true });

  const client = await pool.connect();
  try {
    await client.query("begin");
    const folderIds = new Map<string, string | null>([["", targetId]]);
    const nextSort = new Map<string, number>();
    const sortFor = async (parentId: string | null, table: "doc" | "doc_folder") => {
      const key = `${table}:${parentId ?? ""}`;
      if (!nextSort.has(key)) {
        const col = table === "doc" ? "folder_id" : "parent_id";
        const { rows } = await client.query<{ m: number | null }>(
          `select max(sort_order) as m from ${table} where organization_id = $1 and ${col} is not distinct from $2 and deleted_at is null`,
          [organizationId, parentId],
        );
        nextSort.set(key, Number(rows[0]?.m ?? 0));
      }
      const n = (nextSort.get(key) ?? 0) + 1;
      nextSort.set(key, n);
      return n;
    };

    /** Folder id for a path like "Handbook/Onboarding" (existing folders with the same name are reused) */
    const ensureFolder = async (dir: string): Promise<string | null> => {
      if (folderIds.has(dir)) return folderIds.get(dir) ?? null;
      const slash = dir.lastIndexOf("/");
      const parentId = await ensureFolder(slash < 0 ? "" : dir.slice(0, slash));
      const name = (slash < 0 ? dir : dir.slice(slash + 1)).slice(0, 200);
      // Reuse a folder with the same name, but only one the user can write into
      const { rows } = await client.query<{ id: string; level: number }>(
        `select id, doc_access_level($4, id) as level from doc_folder
          where organization_id = $1 and parent_id is not distinct from $2 and name = $3 and deleted_at is null
          order by created_at limit 1`,
        [organizationId, parentId, name, user.id],
      );
      const existing = rows[0];
      if (existing && Number(existing.level) < 2)
        report.warnings.push({ path: dir, message: "A folder with this name exists but you can't edit it: a new folder was created" });
      let id = existing && Number(existing.level) >= 2 ? existing.id : null;
      if (id) report.folders.reused++;
      else {
        id = newId();
        report.folders.created++;
        if (!dryRun)
          await client.query(
            `insert into doc_folder (id, organization_id, parent_id, name, inherit_grants, sort_order, created_by, created_at, updated_at)
             values ($1, $2, $3, $4, true, $5, $6, now(), now())`,
            [id, organizationId, parentId, name, await sortFor(parentId, "doc_folder"), user.id],
          );
      }
      folderIds.set(dir, id);
      return id;
    };

    for (const entry of entries) {
      let content: string;
      try {
        content = decoder.decode(entry.data).replace(/\r\n/g, "\n");
      } catch {
        report.failures.push({ path: entry.path, message: "Not valid UTF-8 text" });
        continue;
      }
      if (content.length > 500_000) {
        report.failures.push({ path: entry.path, message: "Too long (500,000 characters maximum)" });
        continue;
      }
      const slash = entry.path.lastIndexOf("/");
      const fileName = slash < 0 ? entry.path : entry.path.slice(slash + 1);
      const title = titleFromMarkdown(content, fileName);
      if (/!\[[^\]]*\]\((?!https?:|\/api\/files\/)[^)]+\)/.test(content))
        report.warnings.push({ path: entry.path, message: "Contains images with relative paths: they won't display until re-uploaded" });
      try {
        const folderId = await ensureFolder(slash < 0 ? "" : entry.path.slice(0, slash));
        if (!dryRun) {
          const docId = newId();
          await client.query(
            `insert into doc (id, organization_id, folder_id, title, content, version, inherit_grants, sort_order, source,
                              created_by, created_at, updated_by, updated_at)
             values ($1, $2, $3, $4, $5, 1, true, $6, $7, $8, now(), $8, now())`,
            [
              docId,
              organizationId,
              folderId,
              title,
              content,
              await sortFor(folderId, "doc"),
              `import:${entry.path}`.slice(0, 500),
              user.id,
            ],
          );
          await client.query(
            `insert into doc_version (id, organization_id, doc_id, number, title, content, author_id, created_at)
             values ($1, $2, $3, 1, $4, $5, $6, now())`,
            [newId(), organizationId, docId, title, content, user.id],
          );
        }
        report.docs.push({ path: entry.path, title });
      } catch (e) {
        report.failures.push({ path: entry.path, message: (e as Error).message });
      }
    }
    await client.query(dryRun ? "rollback" : "commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return c.json(report);
}

async function nodeInfo(c: Context) {
  const user = await userFrom(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const organizationId = c.req.query("organizationId") ?? "";
  const id = c.req.param("id") ?? "";
  if (!(await orgRole(user.id, organizationId))) return c.json({ error: "not_found" }, 404);
  const { rows } = await pool.query<{ kind: "doc" | "folder"; title: string; deleted: boolean; level: number }>(
    `select kind, title, deleted, doc_access_level($1, id) as level from (
       select 'doc' as kind, d.id, d.title, d.deleted_at is not null as deleted from doc d where d.id = $2 and d.organization_id = $3
       union all
       select 'folder', f.id, f.name, f.deleted_at is not null from doc_folder f where f.id = $2 and f.organization_id = $3
     ) n limit 1`,
    [user.id, id, organizationId],
  );
  const n = rows[0];
  if (!n) return c.json({ error: "not_found" }, 404);
  const level = Number(n.level);
  return c.json({ id, kind: n.kind, level, deleted: level > 0 ? n.deleted : false, title: level > 0 ? n.title : null });
}

export function mountDocs(app: Hono) {
  app.get("/api/docs/node/:id", nodeInfo);
  app.post(
    "/api/docs/import",
    bodyLimit({ maxSize: IMPORT_MAX_BYTES, onError: (c) => c.json({ error: "file_too_large", maxBytes: IMPORT_MAX_BYTES }, 413) }),
    importDocs,
  );
}
