/**
 * Shared helpers of the REST API v1: execution through Zero (same queries, mutators and permission
 * rules as the web app), serialization to the public (snake_case) shapes, cursors and time parsing.
 */
import { splitMentions } from "@feedbacks/schema/chat";
import type { ZeroContext } from "@feedbacks/schema/zero";
import { mutators } from "@feedbacks/schema/zero";
import type { Transaction } from "@rocicorp/zero";
import { z } from "zod";
import { pool } from "../db";
import { env } from "../env";
import { dbProvider } from "../zero";
import { ApiError } from "./errors";
import type { Caller } from "./registry";

export const zctx = (caller: Caller): ZeroContext => ({ userID: caller.userId, via: caller.via, client: caller.client });

/** Runs ZQL (built with the shared permission filters) against Postgres */
export const read = dbProvider.run.bind(dbProvider);

type MutatorFn<A> = { fn: (o: { args: A; tx: Transaction; ctx: ZeroContext }) => Promise<void> };

/** Runs a Zero mutator on the server, as the caller (validation, permissions, side effects included) */
export async function mutate<A>(caller: Caller, mutator: MutatorFn<A>, args: A): Promise<void> {
  await dbProvider.transaction((tx) => mutator.fn({ tx: tx as unknown as Transaction, ctx: zctx(caller), args }));
}

export { mutators };

/* ------------------------------ Time ------------------------------ */

export const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

/** ISO 8601 date, epoch milliseconds, or a duration ago: "90s", "30m", "24h", "7d", "2w" */
export function parseTime(value: string): number {
  const d = /^(\d+)\s*(s|m|h|d|w)$/i.exec(value.trim());
  if (d) {
    const n = Number(d[1]);
    const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[(d[2] as string).toLowerCase() as "s"];
    return Date.now() - n * unit;
  }
  if (/^\d{10,}$/.test(value)) return Number(value);
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new ApiError(400, "invalid_request", `Invalid date or duration: ${value}`);
  return t;
}

export const timeParam = z
  .string()
  .max(40)
  .transform((v) => parseTime(v));

/* ------------------------------ Cursors ------------------------------ */

/** Opaque keyset cursor: (timestamp, id) of the last item of a page */
export const encodeCursor = (t: number, id: string) => Buffer.from(JSON.stringify([t, id])).toString("base64url");
export function decodeCursor(cursor: string): { t: number; id: string } {
  try {
    const [t, id] = JSON.parse(Buffer.from(cursor, "base64url").toString()) as [number, string];
    if (typeof t === "number" && typeof id === "string") return { t, id };
  } catch {}
  throw new ApiError(400, "invalid_request", "Invalid cursor");
}

export const limitParam = (max: number, def: number) => z.coerce.number().int().min(1).max(max).default(def);

/* ------------------------------ Links and names ------------------------------ */

const slugs = new Map<string, string>();
export async function orgSlug(organizationId: string) {
  let slug = slugs.get(organizationId);
  if (!slug) {
    const { rows } = await pool.query<{ slug: string }>("select slug from organization where id = $1", [organizationId]);
    slug = rows[0]?.slug ?? organizationId;
    slugs.set(organizationId, slug);
  }
  return slug;
}

export const links = {
  ticket: (slug: string, key: string) => `${env.appUrl}/${slug}/issue/${key}`,
  channel: (slug: string, channelId: string) => `${env.appUrl}/${slug}/c/${encodeURIComponent(channelId)}`,
  message: (slug: string, channelId: string, messageId: string, parentId?: string | null) =>
    `${env.appUrl}/${slug}/c/${encodeURIComponent(channelId)}?m=${messageId}${parentId ? `&thread=${parentId}` : ""}`,
  doc: (slug: string, docId: string) => `${env.appUrl}/${slug}/docs/d/${docId}`,
  file: (attachmentId: string) => `${env.appUrl}/api/files/${attachmentId}`,
};

/** Names of users (members of the organization), for mentions and DM titles */
export async function userNames(organizationId: string, ids: Iterable<string>): Promise<Map<string, string>> {
  const list = [...new Set(ids)];
  if (!list.length) return new Map();
  const { rows } = await pool.query<{ id: string; name: string }>(
    `select u.id, u.name from "user" u join member m on m.user_id = u.id and m.organization_id = $1 where u.id = any($2)`,
    [organizationId, list],
  );
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Message body with `<@userId>` tokens resolved to "@Name" (plain text for agents) */
export function plainText(body: string, names: Map<string, string>): string {
  return splitMentions(body)
    .map((p) => (p.type === "text" ? p.value : `@${names.get(p.userId) ?? "unknown"}`))
    .join("");
}

export const mentionIds = (bodies: Iterable<string>) => {
  const ids = new Set<string>();
  for (const b of bodies) for (const p of splitMentions(b)) if (p.type === "mention") ids.add(p.userId);
  return ids;
};
