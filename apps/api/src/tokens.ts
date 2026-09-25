/**
 * Personal access tokens (REST API v1, CLI, MCP).
 *
 * - Format: `fbk_` + 43 base64url characters (256 random bits). Only the SHA-256 is stored.
 * - A token belongs to one member of one organization and carries a scope: `read` (GET only) or
 *   `read-write`. It never grants more than its owner can do in that organization: every request is
 *   executed as that user (same queries, mutators and permission checks as the web app).
 * - A token stops working when revoked, expired, or when its owner leaves the organization.
 */
import { createHash, randomBytes } from "node:crypto";
import { pool } from "./db";

export const TOKEN_PREFIX = "fbk_";
export type TokenScope = "read" | "read-write";

export type TokenCaller = {
  tokenId: string;
  userId: string;
  userName: string;
  organizationId: string;
  role: string;
  scope: TokenScope;
};

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function generateToken() {
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token), prefix: token.slice(0, TOKEN_PREFIX.length + 6) };
}

/** `Authorization: Bearer fbk_…` → the token (other bearer values, e.g. session tokens, are ignored) */
export function bearerToken(headers: Headers): string | null {
  const value = headers.get("authorization");
  if (!value) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(value.trim());
  return m?.[1]?.startsWith(TOKEN_PREFIX) ? m[1] : null;
}

/** last_used_at is written at most once a minute per token (no write on every request) */
const LAST_USED_WRITE_MS = 60_000;
const lastUsedWrites = new Map<string, number>();

export async function authenticateToken(token: string): Promise<TokenCaller | null> {
  const { rows } = await pool.query<{
    id: string;
    user_id: string;
    user_name: string;
    organization_id: string;
    scope: TokenScope;
    role: string;
  }>(
    `select t.id, t.user_id, u.name as user_name, t.organization_id, t.scope, m.role
       from api_token t
       join "user" u on u.id = t.user_id
       join member m on m.organization_id = t.organization_id and m.user_id = t.user_id
      where t.token_hash = $1
        and t.revoked_at is null
        and (t.expires_at is null or t.expires_at > now())`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return null;
  const now = Date.now();
  if (now - (lastUsedWrites.get(row.id) ?? 0) > LAST_USED_WRITE_MS) {
    lastUsedWrites.set(row.id, now);
    void pool.query("update api_token set last_used_at = now() where id = $1", [row.id]).catch(() => {});
  }
  return {
    tokenId: row.id,
    userId: row.user_id,
    userName: row.user_name,
    organizationId: row.organization_id,
    role: row.role,
    scope: row.scope,
  };
}
