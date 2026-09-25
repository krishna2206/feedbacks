/**
 * Knowledge base helpers shared by the web client, the API, the mutators (and later the MCP server / CLI).
 *
 * Permission model (Drive-like, see docs/ARCHITECTURE.md):
 * - a grant gives the whole organization, a team or a user `read`, `edit` or `manage` on a folder or document;
 * - grants are additive to what the node inherits from its parent folder, unless the node is "restricted"
 *   (`inheritGrants = false`), in which case only its own grants apply;
 * - root-level nodes inherit the organization default: every member can edit;
 * - organization owners and admins can manage everything;
 * - the resolved result is materialized in `acl_entry` by Postgres triggers (Zero filters with it).
 */
import type { AccessLevel, PrincipalType } from "./enums";

export const LEVEL_RANK: Record<AccessLevel, number> = { read: 1, edit: 2, manage: 3 };
export const LEVELS: readonly AccessLevel[] = ["read", "edit", "manage"];

/** What every member gets on root-level folders and documents (materialized as an "org" entry) */
export const DEFAULT_ROOT_LEVEL: AccessLevel = "edit";

/** Trashed folders and documents are purged after this many days */
export const TRASH_RETENTION_DAYS = 30;

export const atLeast = (level: AccessLevel | null | undefined, min: AccessLevel) => !!level && LEVEL_RANK[level] >= LEVEL_RANK[min];
export const maxLevel = (a: AccessLevel | null, b: AccessLevel | null): AccessLevel | null =>
  !a ? b : !b ? a : LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;

export type AclRow = { principalType: PrincipalType; principalId: string | null; level: AccessLevel };

/** Deterministic id of a grant or ACL entry: one per (node, principal) */
export const aclId = (nodeId: string, principalType: PrincipalType, principalId: string | null) =>
  `${nodeId}:${principalType}:${principalId ?? "org"}`;

/** Effective level of a user from the resolved entries of a node (owners/admins: manage) */
export function levelFor(
  entries: readonly AclRow[],
  userId: string,
  teamIds: ReadonlySet<string>,
  isOrgAdmin: boolean,
): AccessLevel | null {
  if (isOrgAdmin) return "manage";
  let best: AccessLevel | null = null;
  for (const e of entries) {
    const match =
      e.principalType === "org" ||
      (e.principalType === "user" && e.principalId === userId) ||
      (e.principalType === "team" && !!e.principalId && teamIds.has(e.principalId));
    if (match) best = maxLevel(best, e.level);
  }
  return best;
}

/**
 * Resolves a node's entries from its own grants and its parent's entries (same rule as the SQL
 * `acl_recompute`): used by mutators to mirror the result optimistically on the client.
 */
export function resolveEntries(own: readonly AclRow[], parent: readonly AclRow[] | null, inherit: boolean): AclRow[] {
  const all = [...own];
  if (inherit) all.push(...(parent ?? [{ principalType: "org", principalId: null, level: DEFAULT_ROOT_LEVEL }]));
  const byKey = new Map<string, AclRow>();
  for (const e of all) {
    const key = `${e.principalType}:${e.principalId ?? ""}`;
    const prev = byKey.get(key);
    byKey.set(key, prev ? { ...prev, level: maxLevel(prev.level, e.level) as AccessLevel } : { ...e });
  }
  return [...byKey.values()];
}

/* ------------------------------------------------------------------ */
/* Document mentions: `<doc:ID>` tokens in messages and comments       */
/* ------------------------------------------------------------------ */

export const DOC_MENTION_RE = /<doc:([A-Za-z0-9_-]{1,64})>/g;
export const docMentionToken = (docId: string) => `<doc:${docId}>`;
export const mentionedDocIds = (body: string) => [...new Set(Array.from(body.matchAll(DOC_MENTION_RE), (m) => m[1] as string))];

/* ------------------------------------------------------------------ */
/* Ordering, titles, diffs                                             */
/* ------------------------------------------------------------------ */

/** A sort key between two neighbours (fractional ordering: moving an item only rewrites that item) */
export function sortBetween(before: number | null | undefined, after: number | null | undefined): number {
  if (before == null && after == null) return 1;
  if (before == null) return (after as number) - 1;
  if (after == null) return before + 1;
  return (before + after) / 2;
}

/** Title of an imported markdown file: its first `# heading`, else the file name without extension */
export function titleFromMarkdown(content: string, fileName: string): string {
  const h = /^#\s+(.+?)\s*#*\s*$/m.exec(content);
  const fromName = fileName
    .replace(/\.(md|markdown|txt)$/i, "")
    .replace(/[_]+/g, " ")
    .trim();
  return (h?.[1] ?? fromName ?? "Untitled").slice(0, 200) || "Untitled";
}

export type DiffLine = { type: "same" | "add" | "del"; text: string };

/**
 * Line diff (longest common subsequence). Documents are small; past `maxCells` comparisons the diff
 * degrades to "everything removed / everything added" rather than blocking the UI.
 */
export function lineDiff(before: string, after: string, maxCells = 4_000_000): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  // Trim the common prefix and suffix first: most edits touch a few lines
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head: DiffLine[] = a.slice(0, start).map((text) => ({ type: "same", text }));
  const tail: DiffLine[] = a.slice(endA).map((text) => ({ type: "same", text }));
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  if (x.length * y.length > maxCells) {
    return [...head, ...x.map((text) => ({ type: "del" as const, text })), ...y.map((text) => ({ type: "add" as const, text })), ...tail];
  }
  const n = x.length;
  const m = y.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      (lcs[i] as Uint32Array)[j] =
        x[i] === y[j]
          ? ((lcs[i + 1] as Uint32Array)[j + 1] as number) + 1
          : Math.max((lcs[i + 1] as Uint32Array)[j] as number, (lcs[i] as Uint32Array)[j + 1] as number);
  const mid: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      mid.push({ type: "same", text: x[i] as string });
      i++;
      j++;
    } else if (((lcs[i + 1] as Uint32Array)[j] as number) >= ((lcs[i] as Uint32Array)[j + 1] as number))
      mid.push({ type: "del", text: x[i++] as string });
    else mid.push({ type: "add", text: y[j++] as string });
  }
  while (i < n) mid.push({ type: "del", text: x[i++] as string });
  while (j < m) mid.push({ type: "add", text: y[j++] as string });
  return [...head, ...mid, ...tail];
}

/** Save conflicts: the server refuses a save based on an older version unless `force` is set */
export const DOC_CONFLICT = "DOC_CONFLICT";
export const docConflictMessage = (currentVersion: number) => `${DOC_CONFLICT}:${currentVersion}`;
export function parseDocConflict(message: string | undefined | null): number | null {
  if (!message?.includes(DOC_CONFLICT)) return null;
  const n = Number(message.slice(message.indexOf(DOC_CONFLICT) + DOC_CONFLICT.length + 1).split(/\D/)[0]);
  return Number.isFinite(n) ? n : null;
}
