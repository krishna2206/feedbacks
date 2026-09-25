/**
 * Ticket helpers shared by the web client, the API, the mutators (and later the MCP server / CLI).
 */
import type { ProjectRole, TicketStatus } from "./enums";

export const TICKET_STATUSES: readonly TicketStatus[] = ["triage", "backlog", "todo", "in_progress", "in_review", "done", "canceled"];

/** Statuses that close a ticket (completedAt is set, hidden by "Active" views) */
export const isClosedStatus = (s: TicketStatus) => s === "done" || s === "canceled";

/** "Active" = work that is planned or in progress */
export const ACTIVE_STATUSES: readonly TicketStatus[] = ["todo", "in_progress", "in_review"];
export const BACKLOG_STATUSES: readonly TicketStatus[] = ["triage", "backlog"];

/** Status shown to people when a ticket is created from chat messages (someone must triage it) */
export const DEFAULT_STATUS_FROM_MESSAGES: TicketStatus = "triage";
export const DEFAULT_STATUS: TicketStatus = "todo";

export const ticketKey = (projectKey: string, number: number) => `${projectKey}-${number}`;

/** "APP-12" → { key: "APP", number: 12 } (case-insensitive key) */
export function parseTicketKey(value: string): { key: string; number: number } | null {
  const m = /^([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,9})$/.exec(value.trim());
  if (!m) return null;
  return { key: (m[1] as string).toUpperCase(), number: Number(m[2]) };
}

/** Project keys: 1–10 chars, uppercase letters/digits, starting with a letter */
export function normalizeProjectKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^[0-9]+/, "")
    .slice(0, 10);
}
export const isValidProjectKey = (key: string) => /^[A-Z][A-Z0-9]{0,9}$/.test(key);

/* ------------------------------------------------------------------ */
/* Project roles                                                       */
/* ------------------------------------------------------------------ */

/**
 * Effective role of a user in a project:
 * - "admin": organization owner or admin (full access everywhere)
 * - lead / contributor / reporter / viewer: project membership
 * - "viewer" is also implied for org members when the project visibility is "org"
 */
export type EffectiveProjectRole = "admin" | ProjectRole;

/** Create and edit tickets */
export const canEditTickets = (r: EffectiveProjectRole | null | undefined) => r === "admin" || r === "lead" || r === "contributor";
/** Comment on tickets */
export const canComment = (r: EffectiveProjectRole | null | undefined) => canEditTickets(r) || r === "reporter";
/** Rename the project, manage its members */
export const canManageProject = (r: EffectiveProjectRole | null | undefined) => r === "admin" || r === "lead";

/* ------------------------------------------------------------------ */
/* Tickets built from chat messages                                     */
/* ------------------------------------------------------------------ */

export type SourceMessage = { authorName: string; createdAt: number; body: string; attachmentNames?: readonly string[] };

const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const hhmm = (ts: number) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Title proposal: the first 80 characters of the first message that has text */
export function titleFromMessages(messages: readonly SourceMessage[], max = 80): string {
  const first = messages.find((m) => flat(m.body));
  if (!first) return "";
  const text = flat(first.body);
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * Deterministic description built from the source messages (no AI):
 *   > **Name** · 14:32 — text
 *   >
 *   > **Name** · 14:33 — _screenshot.png_
 */
export function descriptionFromMessages(messages: readonly SourceMessage[]): string {
  return messages
    .map((m) => {
      const text = flat(m.body) || (m.attachmentNames?.length ? `_${m.attachmentNames.join(", ")}_` : "");
      return `> **${m.authorName}** · ${hhmm(m.createdAt)} — ${text}`;
    })
    .join("\n>\n");
}

/**
 * Error raised by `tickets.create` / `tickets.linkMessages` when a message is already a source of another
 * ticket (retry with `force: true`). Encoded in the error message so every client (web, API, MCP) can parse it.
 */
export const ALREADY_LINKED = "ALREADY_LINKED";
export const alreadyLinkedMessage = (links: readonly { messageId: string; ticketId: string }[]) =>
  `${ALREADY_LINKED}:${links.map((l) => `${l.messageId}=${l.ticketId}`).join(",")}`;
export function parseAlreadyLinked(message: string | undefined): { messageId: string; ticketId: string }[] | null {
  if (!message?.includes(ALREADY_LINKED)) return null;
  const list = message.slice(message.indexOf(ALREADY_LINKED) + ALREADY_LINKED.length + 1).split(/[,\s]/);
  return list
    .map((pair) => pair.split("="))
    .filter((p): p is [string, string] => p.length === 2 && !!p[0] && !!p[1])
    .map(([messageId, ticketId]) => ({ messageId, ticketId }));
}
