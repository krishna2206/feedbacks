/**
 * Personal access tokens management (web app, session auth):
 *
 *   GET    /api/tokens?organizationId=…[&all=1]   my tokens, or every token of the organization (owners/admins)
 *   POST   /api/tokens                            { organizationId, name, scope, expiresInDays? } → secret shown once
 *   DELETE /api/tokens/:id                        revoke (the token's owner, or an organization owner/admin)
 *
 * Tokens are not synced by Zero (their hashes never leave Postgres).
 */
import { newId } from "@feedbacks/schema/ids";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { auth } from "../auth";
import { pool } from "../db";
import { generateToken } from "../tokens";

const isAdmin = (role: string | undefined) => role === "owner" || role === "admin";

async function sessionUser(c: Context) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ?? null;
}

async function roleIn(organizationId: string, userId: string) {
  const { rows } = await pool.query<{ role: string }>("select role from member where organization_id = $1 and user_id = $2", [
    organizationId,
    userId,
  ]);
  return rows[0]?.role;
}

type TokenRow = {
  id: string;
  user_id: string;
  user_name: string;
  name: string;
  prefix: string;
  scope: string;
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
};

const toJson = (r: TokenRow) => ({
  id: r.id,
  userId: r.user_id,
  userName: r.user_name,
  name: r.name,
  prefix: r.prefix,
  scope: r.scope,
  createdAt: r.created_at.getTime(),
  expiresAt: r.expires_at?.getTime() ?? null,
  lastUsedAt: r.last_used_at?.getTime() ?? null,
  revokedAt: r.revoked_at?.getTime() ?? null,
  expired: !!r.expires_at && r.expires_at.getTime() < Date.now(),
});

const createBody = z.object({
  organizationId: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(80),
  scope: z.enum(["read", "read-write"]),
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
});

export function mountTokens(app: Hono) {
  app.get("/api/tokens", async (c) => {
    const user = await sessionUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const organizationId = c.req.query("organizationId") ?? "";
    const role = await roleIn(organizationId, user.id);
    if (!role) return c.json({ error: "forbidden" }, 403);
    const all = c.req.query("all") === "1";
    if (all && !isAdmin(role)) return c.json({ error: "forbidden" }, 403);
    const { rows } = await pool.query<TokenRow>(
      `select t.id, t.user_id, u.name as user_name, t.name, t.prefix, t.scope, t.created_at, t.expires_at, t.last_used_at, t.revoked_at
         from api_token t join "user" u on u.id = t.user_id
        where t.organization_id = $1 and ($2::boolean or t.user_id = $3)
        order by t.revoked_at is not null, t.created_at desc
        limit 500`,
      [organizationId, all, user.id],
    );
    return c.json({ tokens: rows.map(toJson) });
  });

  app.post("/api/tokens", async (c) => {
    const user = await sessionUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    if (!c.req.header("content-type")?.includes("application/json")) return c.json({ error: "unsupported_media_type" }, 415);
    const parsed = createBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    const b = parsed.data;
    if (!(await roleIn(b.organizationId, user.id))) return c.json({ error: "forbidden" }, 403);
    const { token, hash, prefix } = generateToken();
    const id = newId();
    const expiresAt = b.expiresInDays ? new Date(Date.now() + b.expiresInDays * 86_400_000) : null;
    await pool.query(
      `insert into api_token (id, organization_id, user_id, name, token_hash, prefix, scope, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, b.organizationId, user.id, b.name, hash, prefix, b.scope, expiresAt],
    );
    // The secret is returned once and never stored
    return c.json({ id, token, name: b.name, prefix, scope: b.scope, expiresAt: expiresAt?.getTime() ?? null }, 201);
  });

  app.delete("/api/tokens/:id", async (c) => {
    const user = await sessionUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const { rows } = await pool.query<{ organization_id: string; user_id: string; revoked_at: Date | null }>(
      "select organization_id, user_id, revoked_at from api_token where id = $1",
      [c.req.param("id")],
    );
    const t = rows[0];
    if (!t) return c.json({ error: "not_found" }, 404);
    const role = await roleIn(t.organization_id, user.id);
    if (!role || (t.user_id !== user.id && !isAdmin(role))) return c.json({ error: "not_found" }, 404);
    if (!t.revoked_at)
      await pool.query("update api_token set revoked_at = now(), revoked_by = $2 where id = $1", [c.req.param("id"), user.id]);
    return c.json({ ok: true });
  });
}
