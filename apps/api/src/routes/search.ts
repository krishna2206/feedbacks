/**
 * Full-text search.
 *
 *   GET /api/search?organizationId=…&q=…[&types=message,ticket,comment][&channelId][&projectId][&authorId][&from][&to][&limit]
 *
 * Postgres FTS over `search_doc` (kept up to date by triggers, see migration 0004): `simple`
 * configuration over text folded by `search_fold` (unaccent), so matching is case- and accent-insensitive
 * in every language, without stemming. Every word of the query is a prefix: results follow the typing.
 *
 * Results are filtered with the same rules as the Zero queries (see @feedbacks/schema/zero/permissions):
 * - messages: public channels of the organization, private channels and DMs the user belongs to;
 * - tickets and comments: readable projects (org-visible, member, org admin) or tickets built from
 *   the user's own messages;
 * - documents: `doc_access_level()` ≥ read (resolved ACL, see migration 0005), trashed ones excluded.
 * Snippets are cut and highlighted here on the ORIGINAL text (ts_headline would only highlight the
 * folded text, losing accents), with private-use markers around matches (rendered as <mark> by the
 * client, never as HTML).
 */
import type { Context, Hono } from "hono";
import { z } from "zod";
import { auth } from "../auth";
import { pool } from "../db";

export const HIGHLIGHT_START = "\uE000";
export const HIGHLIGHT_END = "\uE001";
const MARKERS = new RegExp(`[${HIGHLIGHT_START}${HIGHLIGHT_END}]`, "g");

/* Case/accent folding close to Postgres unaccent + lower (used for highlighting only; matching is SQL) */
const LIGATURES: Record<string, string> = { œ: "oe", æ: "ae", ß: "ss", ø: "o", đ: "d", ł: "l", ı: "i" };
export const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[œæßøđłı]/g, (c) => LIGATURES[c] ?? c);

/** Words of a query, folded (the prefixes to highlight) */
export const queryWords = (input: string) =>
  input
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);

/**
 * Wraps every word starting with one of `terms` in markers. With `max`, cuts a window of about
 * `max` characters around the first match (whitespace collapsed, "…" where text was cut).
 */
export function highlight(text: string, terms: readonly string[], max?: number): string {
  const flat = max ? text.replace(/\s+/g, " ").trim() : text;
  const ranges: [number, number][] = [];
  for (const m of flat.matchAll(/[\p{L}\p{N}]+/gu)) {
    const start = m.index ?? 0;
    const word = fold(m[0]);
    if (terms.some((t) => word.startsWith(t))) ranges.push([start, start + m[0].length]);
  }
  let from = 0;
  let to = flat.length;
  if (max && flat.length > max) {
    const anchor = ranges[0]?.[0] ?? 0;
    from = Math.max(0, anchor - Math.floor(max / 3));
    if (from > 0) from = flat.indexOf(" ", from) + 1 || from; // start on a word
    to = Math.min(flat.length, from + max);
    if (to < flat.length) to = flat.lastIndexOf(" ", to) > from ? flat.lastIndexOf(" ", to) : to;
  }
  let out = from > 0 ? "… " : "";
  let pos = from;
  for (const [a, b] of ranges) {
    if (b <= from || a >= to) continue;
    out += flat.slice(pos, Math.max(a, from)) + HIGHLIGHT_START + flat.slice(Math.max(a, from), Math.min(b, to)) + HIGHLIGHT_END;
    pos = Math.min(b, to);
  }
  out += flat.slice(pos, to) + (to < flat.length ? " …" : "");
  return out;
}

const SEARCH_KINDS = ["message", "ticket", "comment", "doc"] as const;
type SearchKind = (typeof SEARCH_KINDS)[number];

const params = z.object({
  organizationId: z.string().min(1).max(64),
  q: z.string().trim().min(1).max(200),
  types: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").filter((k): k is SearchKind => (SEARCH_KINDS as readonly string[]).includes(k)) : null)),
  channelId: z.string().min(1).max(320).optional(),
  projectId: z.string().min(1).max(64).optional(),
  authorId: z.string().min(1).max(64).optional(),
  from: z.coerce.number().int().positive().optional(),
  to: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/**
 * Turns free text into a prefix tsquery: every word must match the beginning of a word.
 * Words only contain letters and digits, so quoting them is safe.
 */
export function toPrefixQuery(input: string): string | null {
  const words = queryWords(input);
  return words.length ? words.map((w) => `'${w}':*`).join(" & ") : null;
}

type Row = {
  id: string;
  kind: SearchKind;
  entity_id: string;
  created_at: Date;
  body: string;
  author_id: string | null;
  author_name: string | null;
  channel_id: string | null;
  channel_name: string | null;
  channel_kind: string | null;
  parent_id: string | null;
  ticket_id: string | null;
  ticket_number: number | null;
  ticket_title: string | null;
  ticket_status: string | null;
  project_id: string | null;
  project_key: string | null;
  project_name: string | null;
  project_color: string | null;
  doc_id: string | null;
  doc_title: string | null;
  doc_folder_id: string | null;
};

const SQL = `
  with q as (select to_tsquery('simple', search_fold($2)) as tsq)
  select d.id, d.kind, d.entity_id, d.created_at, d.body,
         d.author_id, u.name as author_name,
         c.id as channel_id, c.name as channel_name, c.kind as channel_kind, msg.parent_id,
         t.id as ticket_id, t.number as ticket_number, t.title as ticket_title, t.status as ticket_status,
         p.id as project_id, p.key as project_key, p.name as project_name, p.color as project_color,
         dd.id as doc_id, dd.title as doc_title, dd.folder_id as doc_folder_id
    from search_doc d
   cross join q
    left join channel c on c.id = d.channel_id
    left join message msg on d.kind = 'message' and msg.id = d.entity_id
    left join ticket t on t.id = d.ticket_id
    left join project p on p.id = t.project_id
    left join "user" u on u.id = d.author_id
    left join doc dd on d.kind = 'doc' and dd.id = d.entity_id
   where d.organization_id = $1
     and d.tsv @@ q.tsq
     and (d.kind <> 'message' or (c.id is not null and (
            c.kind = 'public'
            or exists (select 1 from channel_member cm where cm.channel_id = c.id and cm.user_id = $3))))
     and (d.kind not in ('ticket', 'comment') or (t.id is not null and (
            p.visibility = 'org'
            or $4::boolean
            or exists (select 1 from project_member pm where pm.project_id = p.id and pm.user_id = $3)
            or exists (select 1 from ticket_source ts join message sm on sm.id = ts.message_id
                        where ts.ticket_id = t.id and sm.author_id = $3))))
     and (d.kind <> 'doc' or (dd.id is not null and dd.deleted_at is null and ($4::boolean or doc_access_level($3, dd.id) >= 1)))
     and ($5::text[] is null or d.kind = any($5::text[]))
     and ($6::text is null or d.channel_id = $6)
     and ($7::text is null or d.project_id = $7)
     and ($8::text is null or d.author_id = $8)
     and ($9::timestamptz is null or d.created_at >= $9)
     and ($10::timestamptz is null or d.created_at < $10)
   order by ts_rank_cd(d.tsv, q.tsq, 32) desc, d.created_at desc
   limit $11`;

async function search(c: Context) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const parsed = params.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsed.success) return c.json({ error: "invalid_query", issues: parsed.error.issues }, 400);
  const p = parsed.data;
  const userId = session.user.id;

  const membership = await pool.query<{ role: string }>("select role from member where organization_id = $1 and user_id = $2", [
    p.organizationId,
    userId,
  ]);
  const role = membership.rows[0]?.role;
  if (!role) return c.json({ error: "forbidden" }, 403);

  const tsquery = toPrefixQuery(p.q);
  if (!tsquery) return c.json({ results: [] });
  const { rows } = await pool.query<Row>(SQL, [
    p.organizationId,
    tsquery,
    userId,
    role === "owner" || role === "admin",
    p.types?.length ? p.types : null,
    p.channelId ?? null,
    p.projectId ?? null,
    p.authorId ?? null,
    p.from ? new Date(p.from) : null,
    p.to ? new Date(p.to) : null,
    p.limit,
  ]);
  const terms = queryWords(p.q).map(fold);

  return c.json({
    results: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      entityId: r.entity_id,
      createdAt: r.created_at.getTime(),
      /** Body excerpt (messages, comments, ticket description) with highlighted matches */
      snippet: r.body ? highlight(r.body, terms, 180) : "",
      /** Highlighted ticket title (tickets and comments) or document title */
      title: r.doc_title ? highlight(r.doc_title, terms) : r.ticket_title ? highlight(r.ticket_title, terms) : "",
      author: r.author_id ? { id: r.author_id, name: r.author_name ?? "" } : null,
      channel: r.channel_id ? { id: r.channel_id, name: r.channel_name ?? "", kind: r.channel_kind ?? "public" } : null,
      parentId: r.parent_id,
      ticket: r.ticket_id
        ? {
            id: r.ticket_id,
            key: `${r.project_key ?? "?"}-${r.ticket_number}`,
            title: r.ticket_title ?? "",
            status: r.ticket_status ?? "todo",
          }
        : null,
      doc: r.doc_id ? { id: r.doc_id, title: r.doc_title ?? "", folderId: r.doc_folder_id } : null,
      project: r.project_id
        ? { id: r.project_id, key: r.project_key ?? "", name: r.project_name ?? "", color: r.project_color ?? "#888888" }
        : null,
    })),
  });
}

/** Plain text of a highlighted string (tests, logs) */
export const stripHighlights = (s: string) => s.replace(MARKERS, "");

export function mountSearch(app: Hono) {
  app.get("/api/search", search);
}
