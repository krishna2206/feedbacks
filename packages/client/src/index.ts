/**
 * Client of the Feedbacks REST API v1 (see /api/v1/reference). No dependencies: works in Node 22+,
 * browsers and edge runtimes. Used by the CLI and the MCP server.
 *
 *   const api = createClient({ url: "https://feedbacks.example.com", token: "fbk_…" });
 *   const { data } = await api.messages.list("feedback", { unprocessed: true, since: "24h" });
 */

export type ChannelKind = "public" | "private" | "dm";
export type TicketStatus = "triage" | "backlog" | "todo" | "in_progress" | "in_review" | "done" | "canceled";
export type PriorityName = "none" | "urgent" | "high" | "medium" | "low";

export interface UserRef {
  id: string;
  name: string;
}

export interface Me {
  user: { id: string; name: string; email: string };
  organization: { id: string; name: string; slug: string };
  role: string;
  token: { id: string; scope: "read" | "read-write" };
}

export interface Member {
  id: string;
  name: string;
  email: string;
  role: string;
}

export interface Channel {
  id: string;
  kind: ChannelKind;
  name: string;
  topic: string | null;
  project_id: string | null;
  archived: boolean;
  is_member: boolean;
  last_message_at: string | null;
  url: string;
}

export interface Attachment {
  id: string;
  kind: string;
  name: string;
  mime_type: string;
  size: number;
  width: number | null;
  height: number | null;
  url: string;
}

export interface TicketRef {
  id: string;
  key: string;
  title: string;
  status: string;
  url: string;
}

export interface Message {
  id: string;
  channel_id: string;
  parent_id: string | null;
  author: UserRef | null;
  body: string;
  text: string;
  created_at: string;
  edited_at: string | null;
  reply_count: number;
  attachments: Attachment[];
  reactions: { emoji: string; count: number }[];
  tickets: TicketRef[];
  linked_ticket_count: number;
  via: string | null;
  url: string;
}

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

export interface Label {
  id: string;
  name: string;
  color: string;
}

export interface Project {
  id: string;
  key: string;
  name: string;
  color: string;
  visibility: string;
  archived: boolean;
  role: string | null;
  can_create_tickets: boolean;
}

export interface Ticket {
  id: string;
  key: string;
  number: number;
  url: string;
  project: { id: string; key: string; name: string };
  title: string;
  description: string;
  status: TicketStatus;
  priority: number;
  priority_name: PriorityName;
  assignee: UserRef | null;
  creator: UserRef | null;
  labels: Label[];
  created_via: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  source_message_ids: string[];
}

export interface Comment {
  id: string;
  author: UserRef | null;
  body: string;
  text: string;
  created_at: string;
  edited_at: string | null;
  via: string | null;
}

export interface TicketDetail extends Ticket {
  former_keys: string[];
  source_messages: Message[];
  comments: Comment[];
  docs: { id: string; title: string; url: string }[];
}

export interface SearchResult {
  kind: "message" | "ticket" | "comment" | "doc";
  id: string;
  title: string;
  snippet: string;
  created_at: string;
  author: UserRef | null;
  channel: { id: string; name: string } | null;
  parent_id: string | null;
  ticket: { id: string; key: string; title: string; status: string } | null;
  doc: { id: string; title: string } | null;
  url: string;
}

export type AccessLevel = "read" | "edit" | "manage";

export interface DocSummary {
  id: string;
  title: string;
  folder_id: string | null;
  version: number;
  updated_at: string;
  level: AccessLevel;
  url: string;
}

export interface Doc extends DocSummary {
  content: string;
  updated_by: UserRef | null;
  path: string[];
}

export interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
  level: AccessLevel;
}

export interface Notification {
  id: string;
  kind: string;
  actor: UserRef | null;
  body: string;
  ticket: { id: string; key: string; title: string } | null;
  message_id: string | null;
  channel_id: string | null;
  doc_id: string | null;
  created_at: string;
  read_at: string | null;
}

/** Error returned by the API: `code` is stable (unauthorized, forbidden, not_found, already_linked, doc_conflict…) */
export class FeedbacksApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "FeedbacksApiError";
  }
}

export interface ClientOptions {
  /** Instance URL, e.g. https://feedbacks.example.com (the API lives at /api/v1) */
  url: string;
  /** Personal access token (`fbk_…`, Settings › API tokens) */
  token: string;
  /** Label shown as "via …" on messages and comments you post (default "API") */
  client?: string | (() => string);
  /** "api" (default) or "mcp": recorded as `created_via` on tickets */
  via?: "api" | "mcp";
  /** Custom fetch (tests, in-process calls) */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** Automatic Idempotency-Key on writes (default true): network retries never create duplicates */
  idempotency?: boolean;
  /** Retries on network errors, 429 and 5xx (default 2) */
  retries?: number;
}

type Query = Record<string, string | number | boolean | undefined | null>;

const qs = (q: Query = {}) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};
const enc = encodeURIComponent;
const randomKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createClient(opts: ClientOptions) {
  const base = `${opts.url.replace(/\/+$/, "")}/api/v1`;
  const doFetch = opts.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const retries = opts.retries ?? 2;

  async function request<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const client = typeof opts.client === "function" ? opts.client() : opts.client;
    const headers: Record<string, string> = {
      authorization: `Bearer ${opts.token}`,
      accept: "application/json",
      "x-feedbacks-via": opts.via ?? "api",
      ...(client ? { "x-feedbacks-client": client } : {}),
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET" && (opts.idempotency ?? true)) headers["idempotency-key"] = idempotencyKey ?? randomKey();
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      } catch (e) {
        if (attempt < retries) {
          await sleep(300 * 2 ** attempt);
          continue;
        }
        throw new FeedbacksApiError(0, "network_error", `Cannot reach ${opts.url}: ${(e as Error).message}`);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const wait = Number(res.headers.get("retry-after") ?? 0) * 1000 || 300 * 2 ** attempt;
        await sleep(Math.min(wait, 10_000));
        continue;
      }
      const text = await res.text();
      // biome-ignore lint/suspicious/noExplicitAny: parsed JSON
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {}
      if (!res.ok) {
        const err = json?.error;
        throw new FeedbacksApiError(
          res.status,
          err?.code ?? `http_${res.status}`,
          err?.message ?? (text.slice(0, 200) || res.statusText),
          err?.details,
        );
      }
      return json as T;
    }
  }

  const get = <T>(path: string, q?: Query) => request<T>("GET", path + qs(q));

  return {
    request,
    me: () => get<Me>("/me"),
    users: { list: () => get<{ data: Member[] }>("/users") },
    channels: {
      list: (q: { kind?: ChannelKind; joined?: boolean; include_archived?: boolean } = {}) => get<{ data: Channel[] }>("/channels", q),
      get: (channel: string) => get<Channel>(`/channels/${enc(channel)}`),
    },
    messages: {
      /** Top-level messages, newest first. `since`/`until`: ISO date or duration ("24h", "7d") */
      list: (channel: string, q: { since?: string; until?: string; unprocessed?: boolean; limit?: number; cursor?: string } = {}) =>
        get<Page<Message>>(`/channels/${enc(channel)}/messages`, q),
      get: (id: string) => get<Message>(`/messages/${enc(id)}`),
      thread: (id: string) => get<{ parent: Message; replies: Message[] }>(`/messages/${enc(id)}/thread`),
      post: (channel: string, body: string) => request<Message>("POST", `/channels/${enc(channel)}/messages`, { body }),
      reply: (id: string, body: string) => request<Message>("POST", `/messages/${enc(id)}/replies`, { body }),
    },
    search: (q: { q: string; types?: string; channel?: string; project?: string; limit?: number }) =>
      get<{ data: SearchResult[] }>("/search", q),
    projects: { list: (q: { include_archived?: boolean } = {}) => get<{ data: Project[] }>("/projects", q) },
    labels: { list: () => get<{ data: Label[] }>("/labels") },
    tickets: {
      list: (
        q: {
          project?: string;
          status?: string;
          assignee?: string;
          label?: string;
          created_via?: string;
          updated_since?: string;
          limit?: number;
          cursor?: string;
        } = {},
      ) => get<Page<Ticket>>("/tickets", q),
      get: (ref: string) => get<TicketDetail>(`/tickets/${enc(ref)}`),
      create: (b: {
        project: string;
        title?: string;
        description?: string;
        status?: TicketStatus;
        priority?: number | PriorityName;
        assignee?: string | null;
        labels?: string[];
        source_message_ids?: string[];
        force?: boolean;
      }) => request<TicketDetail>("POST", "/tickets", b),
      update: (
        ref: string,
        b: {
          title?: string;
          description?: string;
          status?: TicketStatus;
          priority?: number | PriorityName;
          assignee?: string | null;
          labels?: string[];
          project?: string;
        },
      ) => request<TicketDetail>("PATCH", `/tickets/${enc(ref)}`, b),
      comment: (ref: string, body: string) => request<Comment>("POST", `/tickets/${enc(ref)}/comments`, { body }),
      link: (ref: string, messageIds: string[], force = false) =>
        request<TicketDetail>("POST", `/tickets/${enc(ref)}/links`, { message_ids: messageIds, force }),
      unlink: (ref: string, messageId: string) => request<TicketDetail>("DELETE", `/tickets/${enc(ref)}/links/${enc(messageId)}`),
    },
    docs: {
      tree: () => get<{ folders: Folder[]; docs: DocSummary[] }>("/docs/tree"),
      get: (id: string) => get<Doc>(`/docs/${enc(id)}`),
      search: (q: string, limit?: number) =>
        get<{ data: { id: string; title: string; snippet: string; url: string }[] }>("/docs/search", { q, limit }),
      create: (b: { title: string; content?: string; folder_id?: string | null }) => request<Doc>("POST", "/docs", b),
      update: (id: string, b: { title?: string; content?: string; base_version?: number; force?: boolean }) =>
        request<Doc>("PATCH", `/docs/${enc(id)}`, b),
    },
    notifications: {
      list: (q: { filter?: "unread" | "all"; limit?: number } = {}) => get<{ data: Notification[] }>("/notifications", q),
      read: (b: { ids?: string[]; all?: boolean }) => request<{ ok: true }>("POST", "/notifications/read", b),
    },
  };
}

export type FeedbacksClient = ReturnType<typeof createClient>;
