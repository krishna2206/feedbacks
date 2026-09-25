/**
 * Attachments.
 *
 *   POST /api/uploads          multipart: file, [thumb], organizationId, channelId | docId, [width], [height]
 *   GET  /api/files/:id        the file (authorized), `?download=1` forces a download
 *   GET  /api/files/:id/thumb  the preview of an image (falls back to the file)
 *
 * A chat upload creates a pending `attachment` row (message_id = null) owned by the uploader;
 * the `messages.send` mutator then attaches it to the message. A document upload (images pasted
 * in the editor) belongs to the document right away: editing it needs edit access, reading it
 * read access, and it is deleted with the document. Previews are generated in the
 * browser before upload (canvas → WebP): no native image library on the server.
 */
import * as s from "@feedbacks/schema/db";
import { newId } from "@feedbacks/schema/ids";
import { eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { auth } from "../auth";
import { db, pool } from "../db";
import { env } from "../env";
import { storage } from "../storage";

/** Images the browser can display safely (SVG is served as a plain file: it can contain scripts) */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
const THUMB_MAX_BYTES = 512 * 1024;

async function userFrom(c: Context) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

/** Channel access for a user: public channels for organization members, others for their members */
async function channelAccess(userId: string, channelId: string) {
  // Explicit SQL on purpose: every column is qualified, so the subqueries can't bind to the wrong table
  const { rows } = await pool.query<{
    organization_id: string;
    kind: string;
    archived_at: Date | null;
    in_org: boolean;
    is_member: boolean;
  }>(
    `select c.organization_id, c.kind, c.archived_at,
            exists(select 1 from member m where m.organization_id = c.organization_id and m.user_id = $2) as in_org,
            exists(select 1 from channel_member cm where cm.channel_id = c.id and cm.user_id = $2) as is_member
       from channel c
      where c.id = $1`,
    [channelId, userId],
  );
  const row = rows[0];
  if (!row?.in_org) return null;
  const canRead = row.kind === "public" || row.is_member;
  // Same rule as messages.send: members, or anyone in the org for public channels (auto-join)
  const canPost = canRead && !row.archived_at;
  return { organizationId: row.organization_id, canRead, canPost };
}

/** Effective access of a user on a document (0 none · 1 read · 2 edit · 3 manage), trashed documents excluded */
async function docLevel(userId: string, docId: string) {
  const { rows } = await pool.query<{ organization_id: string; level: number }>(
    "select d.organization_id, doc_access_level($2, d.id) as level from doc d where d.id = $1 and d.deleted_at is null",
    [docId, userId],
  );
  return rows[0] ? { organizationId: rows[0].organization_id, level: Number(rows[0].level) } : null;
}

const safeName = (name: string) =>
  name
    .normalize("NFKC")
    .replace(/[/\\?%*:|"<>\p{Cc}]/gu, "_")
    .slice(0, 200) || "file";

const contentDisposition = (type: "inline" | "attachment", name: string) =>
  `${type}; filename="${name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(name)}`;

export function mountFiles(app: Hono) {
  app.post(
    "/api/uploads",
    bodyLimit({ maxSize: env.uploadMaxBytes + THUMB_MAX_BYTES + 64 * 1024, onError: (c) => c.json({ error: "file_too_large" }, 413) }),
    async (c) => {
      const user = await userFrom(c);
      if (!user) return c.json({ error: "unauthorized" }, 401);
      const form = await c.req.parseBody();
      const file = form.file;
      const organizationId = String(form.organizationId ?? "");
      const channelId = String(form.channelId ?? "") || null;
      const docId = String(form.docId ?? "") || null;
      if (!(file instanceof File) || !organizationId || !(channelId || docId) || (channelId && docId))
        return c.json({ error: "bad_request" }, 400);
      if (file.size > env.uploadMaxBytes) return c.json({ error: "file_too_large", maxBytes: env.uploadMaxBytes }, 413);

      if (channelId) {
        const access = await channelAccess(user.id, channelId);
        if (!access || access.organizationId !== organizationId || !access.canPost) return c.json({ error: "forbidden" }, 403);
      } else {
        const access = await docLevel(user.id, docId as string);
        if (!access || access.organizationId !== organizationId || access.level < 2) return c.json({ error: "forbidden" }, 403);
      }

      const id = newId();
      const name = safeName(file.name);
      const mimeType = file.type || "application/octet-stream";
      const kind = IMAGE_TYPES.has(mimeType) ? "image" : mimeType.startsWith("audio/") ? "audio" : "file";
      const d = new Date();
      const prefix = `${organizationId}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${id}`;
      const storageKey = `${prefix}/${name}`;
      await storage.put(storageKey, new Uint8Array(await file.arrayBuffer()), mimeType);

      let thumbKey: string | null = null;
      const thumb = form.thumb;
      if (kind === "image" && thumb instanceof File && thumb.size <= THUMB_MAX_BYTES && IMAGE_TYPES.has(thumb.type)) {
        thumbKey = `${prefix}/thumb.${thumb.type.slice("image/".length)}`;
        await storage.put(thumbKey, new Uint8Array(await thumb.arrayBuffer()), thumb.type);
      }

      const dim = (v: unknown) => {
        const n = Number(v);
        return kind === "image" && Number.isInteger(n) && n > 0 && n < 100_000 ? n : null;
      };
      const row = {
        id,
        organizationId,
        channelId,
        docId,
        messageId: null,
        kind: kind as "image" | "file" | "audio",
        name,
        mimeType,
        size: file.size,
        storageKey,
        thumbKey,
        width: dim(form.width),
        height: dim(form.height),
        uploadedBy: user.id,
        createdAt: d,
      };
      await db.insert(s.attachment).values(row);
      // Shape expected by the messages.send mutator (`attachments` argument)
      return c.json({
        id,
        kind: row.kind,
        name,
        mimeType,
        size: row.size,
        storageKey,
        thumbKey,
        width: row.width,
        height: row.height,
        createdAt: d.getTime(),
      });
    },
  );

  const serve = async (c: Context, variant: "file" | "thumb") => {
    const user = await userFrom(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const [a] = await db
      .select()
      .from(s.attachment)
      .where(eq(s.attachment.id, c.req.param("id") ?? ""))
      .limit(1);
    // Same answer for "missing" and "forbidden": ids never leak existence
    if (!a) return c.json({ error: "not_found" }, 404);
    let allowed = false;
    if (a.docId) allowed = ((await docLevel(user.id, a.docId))?.level ?? 0) >= 1;
    else if (!a.messageId)
      allowed = a.uploadedBy === user.id; // pending upload: only its uploader
    else if (a.channelId) allowed = !!(await channelAccess(user.id, a.channelId))?.canRead;
    if (!allowed) return c.json({ error: "not_found" }, 404);

    const useThumb = variant === "thumb" && !!a.thumbKey;
    const key = useThumb ? (a.thumbKey as string) : a.storageKey;
    const type = useThumb ? `image/${key.slice(key.lastIndexOf(".") + 1)}` : a.mimeType;
    const inline = a.kind === "image" && c.req.query("download") === undefined;
    // Non-images are always downloaded and never interpreted by the browser
    const servedType = a.kind === "image" ? type : "application/octet-stream";
    const disposition = contentDisposition(inline ? "inline" : "attachment", a.name);

    if (storage.signedUrl) {
      return c.redirect(await storage.signedUrl(key, { expiresIn: 300, contentType: servedType, disposition }), 302);
    }
    const obj = await storage.get?.(key);
    if (!obj) return c.json({ error: "not_found" }, 404);
    return new Response(obj.body, {
      headers: {
        "content-type": servedType,
        "content-length": String(obj.size),
        "content-disposition": disposition,
        "cache-control": "private, max-age=86400, immutable",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  };

  app.get("/api/files/:id", (c) => serve(c, "file"));
  app.get("/api/files/:id/thumb", (c) => serve(c, "thumb"));
}
