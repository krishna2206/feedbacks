/**
 * REST API v1 (`/api/v1`): the interface of agents, scripts, the CLI and the MCP server.
 *
 * - Auth: `Authorization: Bearer fbk_…` (personal access token). Every request runs as the token's
 *   owner, in the token's organization, through the same Zero queries/mutators as the web app:
 *   an agent can never do more than its user.
 * - Scope: `read` tokens can only call GET routes (403 insufficient_scope otherwise).
 * - Idempotency: POST/PATCH/DELETE accept an `Idempotency-Key` header; the response of the first
 *   request is stored for 24 h and replayed (`Idempotent-Replayed: true`) for retries with the same
 *   key and body. Reusing a key with a different request → 422 idempotency_key_reused.
 * - Rate limits: per token, in memory (per API process): API_RATE_LIMIT_PER_MIN requests and
 *   API_WRITE_RATE_LIMIT_PER_MIN writes per minute; 429 with Retry-After beyond that.
 * - Errors: `{ error: { code, message, details? } }` (see errors.ts).
 */
import { createHash } from "node:crypto";
import { type Context, Hono } from "hono";
import type { z } from "zod";
import { pool } from "../db";
import { env } from "../env";
import { authenticateToken, bearerToken } from "../tokens";
import { drainDeletions } from "../uploads-sweeper";
import { ApiError, errorBody, toApiError } from "./errors";
import { type AnyRoute, type Caller, routes, type V1Env } from "./registry";
import "./routes/index";

/* ------------------------------ Rate limit ------------------------------ */

type Bucket = { tokens: number; at: number };
const buckets = new Map<string, Bucket>();

/** Token bucket: `perMinute` capacity, refilled continuously. Returns seconds to wait (0 = allowed). */
function take(key: string, perMinute: number): { wait: number; remaining: number } {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: perMinute, at: now };
  b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60_000) * perMinute);
  b.at = now;
  buckets.set(key, b);
  if (b.tokens < 1) return { wait: Math.ceil(((1 - b.tokens) / perMinute) * 60), remaining: 0 };
  b.tokens -= 1;
  return { wait: 0, remaining: Math.floor(b.tokens) };
}

/* ------------------------------ Idempotency ------------------------------ */

const IDEMPOTENCY_TTL = "24 hours";

async function withIdempotency(c: Context<V1Env>, caller: Caller, raw: string, run: () => Promise<Response>): Promise<Response> {
  const key = c.req.header("idempotency-key");
  if (!key) return run();
  if (key.length > 200) throw new ApiError(400, "invalid_request", "Idempotency-Key is too long (max 200 characters)");
  const hash = createHash("sha256")
    .update(`${c.req.method} ${new URL(c.req.url).pathname}\n${raw}`)
    .digest("hex");
  await pool.query(`delete from api_idempotency where token_id = $1 and key = $2 and created_at < now() - interval '${IDEMPOTENCY_TTL}'`, [
    caller.tokenId,
    key,
  ]);
  const inserted = await pool.query(
    "insert into api_idempotency (token_id, key, request_hash) values ($1, $2, $3) on conflict do nothing returning key",
    [caller.tokenId, key, hash],
  );
  if (!inserted.rowCount) {
    const { rows } = await pool.query<{ request_hash: string; status: number | null; response: unknown }>(
      "select request_hash, status, response from api_idempotency where token_id = $1 and key = $2",
      [caller.tokenId, key],
    );
    const row = rows[0];
    if (!row) return withIdempotency(c, caller, raw, run);
    if (row.request_hash !== hash) throw new ApiError(422, "idempotency_key_reused", "This Idempotency-Key was used for another request");
    if (row.status === null) throw new ApiError(409, "idempotency_in_progress", "A request with this Idempotency-Key is in progress");
    return new Response(JSON.stringify(row.response), {
      status: row.status,
      headers: { "content-type": "application/json", "idempotent-replayed": "true" },
    });
  }
  // Occasional cleanup of expired keys
  if (Math.random() < 0.02)
    void pool.query(`delete from api_idempotency where created_at < now() - interval '${IDEMPOTENCY_TTL}'`).catch(() => {});
  let res: Response;
  try {
    res = await run();
  } catch (e) {
    const err = toApiError(e);
    res = new Response(JSON.stringify(errorBody(err)), { status: err.status, headers: { "content-type": "application/json" } });
  }
  if (res.status >= 500) {
    // Server errors are not stored: the client may retry with the same key
    await pool.query("delete from api_idempotency where token_id = $1 and key = $2", [caller.tokenId, key]);
  } else {
    await pool.query("update api_idempotency set status = $3, response = $4 where token_id = $1 and key = $2", [
      caller.tokenId,
      key,
      res.status,
      await res.clone().text(),
    ]);
  }
  return res;
}

/* ------------------------------ App ------------------------------ */

const CLIENT_RE = /[^\p{L}\p{N} ._()/-]/gu;

export const v1 = new Hono<V1Env>();

v1.onError((e, c) => {
  const err = toApiError(e);
  if (err.status >= 500) console.error("[api v1]", e);
  return c.json(errorBody(err), err.status as 400);
});
v1.notFound((c) => c.json(errorBody(new ApiError(404, "not_found", "Unknown API route")), 404));

v1.use("*", async (c, next) => {
  const token = bearerToken(c.req.raw.headers);
  const auth = token ? await authenticateToken(token) : null;
  if (!auth) {
    c.header("WWW-Authenticate", 'Bearer realm="feedbacks"');
    throw new ApiError(401, "unauthorized", "Missing, invalid, expired or revoked access token (Authorization: Bearer fbk_…)");
  }
  const via = c.req.header("x-feedbacks-via") === "mcp" ? "mcp" : "api";
  const client = (c.req.header("x-feedbacks-client") ?? "").replace(CLIENT_RE, "").trim().slice(0, 60) || (via === "mcp" ? "MCP" : "API");
  c.set("caller", { ...auth, via, client });

  const write = c.req.method !== "GET" && c.req.method !== "HEAD";
  const all = take(`all:${auth.tokenId}`, env.api.rateLimitPerMin);
  const writes = write && all.wait === 0 ? take(`write:${auth.tokenId}`, env.api.writeRateLimitPerMin) : { wait: 0, remaining: 0 };
  const wait = all.wait || writes.wait;
  c.header("RateLimit-Limit", String(env.api.rateLimitPerMin));
  c.header("RateLimit-Remaining", String(all.remaining));
  if (wait) {
    c.header("Retry-After", String(wait));
    throw new ApiError(429, "rate_limited", `Rate limit exceeded, retry in ${wait}s`, { retryAfter: wait });
  }
  if (write && auth.scope !== "read-write") throw new ApiError(403, "insufficient_scope", "This token is read-only");
  await next();
});

const parseOrThrow = <S extends z.ZodType>(schema: S | undefined, value: unknown): unknown => (schema ? schema.parse(value) : undefined);

function mount(route: AnyRoute) {
  v1.on(route.method.toUpperCase(), route.path, async (c) => {
    const caller = c.get("caller");
    const raw = route.method === "get" ? "" : await c.req.text();
    const execute = async () => {
      const params = parseOrThrow(route.params, c.req.param());
      const query = parseOrThrow(route.query, Object.fromEntries(new URL(c.req.url).searchParams));
      let json: unknown;
      if (route.body) {
        try {
          json = raw ? JSON.parse(raw) : {};
        } catch {
          throw new ApiError(400, "invalid_request", "The body must be valid JSON");
        }
      }
      const body = parseOrThrow(route.body, json);
      const result = await route.handler({ caller, params, query, body, c });
      if (route.method !== "get") drainDeletions();
      return c.json(route.response.parse(result), route.status ?? 200);
    };
    return route.method === "get" ? execute() : withIdempotency(c, caller, raw, execute);
  });
}

for (const route of routes) mount(route);
