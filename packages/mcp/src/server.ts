/**
 * MCP server of Feedbacks. Every tool calls the REST API v1 with the user's personal access token,
 * so an agent can never do more than that user (same permission checks as the web app).
 * Used by the stdio binary (`feedbacks-mcp`) and by the Streamable HTTP endpoint of the API (`/api/mcp`).
 */
import { FeedbacksApiError, type FeedbacksClient } from "@feedbacks/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

declare const __VERSION__: string;
export const MCP_VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "0.1.0";

const INSTRUCTIONS = `Feedbacks is a team workspace: chat channels where people post feedback (text, screenshots),
tickets built from those messages, and a knowledge base of markdown documents.
Typical triage workflow:
1. list_unprocessed_feedback on a channel (messages nobody turned into a ticket yet);
2. group related messages (a text and the screenshots posted right after it), check duplicates with search / list_tickets;
3. PROPOSE a plan to the user and wait for their approval before creating anything;
4. create_ticket_from_messages (title/description default to the quoted messages), or link_messages_to_ticket for a follow-up;
5. reply_in_thread with the ticket key so the reporter knows it is tracked.
Mentions in message bodies are <@userId> tokens (the \`text\` field has them resolved to @Name).
Never pass force=true unless the user explicitly asked to link a message to several tickets.`;

// biome-ignore lint/suspicious/noExplicitAny: tool results are plain JSON
function ok(data: any): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

async function call(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof FeedbacksApiError) {
      const hint =
        e.code === "already_linked"
          ? " Some messages already back another ticket (see details.links): link them to that ticket instead, or retry with force=true only if the user asked for it."
          : e.code === "doc_conflict"
            ? " The document changed since base_version: read_doc again, merge your changes, and retry."
            : e.code === "insufficient_scope"
              ? " The access token is read-only."
              : "";
      return {
        isError: true,
        content: [{ type: "text", text: `${e.code}: ${e.message}.${hint}${e.details ? `\ndetails: ${JSON.stringify(e.details)}` : ""}` }],
      };
    }
    return { isError: true, content: [{ type: "text", text: `error: ${e instanceof Error ? e.message : String(e)}` }] };
  }
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

const channel = z.string().describe('Channel name ("feedback" or "#feedback") or id');
const ticketRef = z.string().describe("Ticket key (e.g. APP-12, former keys work too) or id");
const status = z.enum(["triage", "backlog", "todo", "in_progress", "in_review", "done", "canceled"]);
const priority = z.enum(["none", "urgent", "high", "medium", "low"]);

export function createFeedbacksMcpServer(api: FeedbacksClient) {
  const server = new McpServer({ name: "feedbacks", version: MCP_VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "list_channels",
    {
      title: "List channels",
      description: "Channels the user can read: public channels, private channels and direct messages they belong to.",
      inputSchema: { kind: z.enum(["public", "private", "dm"]).optional(), joined: z.boolean().optional() },
      annotations: READ,
    },
    (a) => call(() => api.channels.list(a)),
  );

  server.registerTool(
    "read_messages",
    {
      title: "Read messages",
      description:
        "Top-level messages of a channel, newest first (thread replies excluded: see reply_count and get_thread). " +
        "Each message lists its attachments (screenshots) and the tickets already built from it.",
      inputSchema: {
        channel,
        since: z.string().optional().describe('ISO date or duration ago, e.g. "24h", "7d"'),
        until: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().optional().describe("next_cursor of a previous page"),
      },
      annotations: READ,
    },
    ({ channel: ch, ...q }) => call(() => api.messages.list(ch, q)),
  );

  server.registerTool(
    "list_unprocessed_feedback",
    {
      title: "List unprocessed feedback",
      description:
        "Messages of other people in a channel that no ticket was built from yet (the feedback still to triage), newest first. " +
        "Screenshots are often posted as separate messages right after the text they illustrate.",
      inputSchema: {
        channel,
        since: z.string().optional().describe('ISO date or duration ago, e.g. "24h", "7d"'),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: READ,
    },
    ({ channel: ch, ...q }) => call(() => api.messages.list(ch, { ...q, unprocessed: true })),
  );

  server.registerTool(
    "get_thread",
    {
      title: "Get a thread",
      description: "A message and all its thread replies, oldest first (details asked and answered about a feedback).",
      inputSchema: { message_id: z.string() },
      annotations: READ,
    },
    ({ message_id }) => call(() => api.messages.thread(message_id)),
  );

  server.registerTool(
    "search",
    {
      title: "Search",
      description:
        "Full-text search in messages, tickets, comments and documents the user can read. Every word is a prefix; case and accents are ignored. Use it to find duplicates before creating a ticket.",
      inputSchema: {
        query: z.string().min(1),
        types: z.array(z.enum(["message", "ticket", "comment", "doc"])).optional(),
        channel: z.string().optional(),
        project: z.string().optional().describe("Project key"),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: READ,
    },
    ({ query, types, ...q }) => call(() => api.search({ q: query, types: types?.join(","), ...q })),
  );

  server.registerTool(
    "post_message",
    {
      title: "Post a message",
      description: "Post a message in a channel as the user (shown with a discreet 'via <client>' mark). Mention people with <@userId>.",
      inputSchema: { channel, body: z.string().min(1) },
      annotations: WRITE,
    },
    ({ channel: ch, body }) => call(() => api.messages.post(ch, body)),
  );

  server.registerTool(
    "reply_in_thread",
    {
      title: "Reply in a thread",
      description:
        "Reply in the thread of a message: ask the reporter for details, or tell them which ticket tracks their feedback (e.g. 'Tracked in APP-12').",
      inputSchema: { message_id: z.string(), body: z.string().min(1) },
      annotations: WRITE,
    },
    ({ message_id, body }) => call(() => api.messages.reply(message_id, body)),
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "Projects the user can read, with their key (ticket prefix) and the user's role (can_create_tickets).",
      inputSchema: {},
      annotations: READ,
    },
    () => call(() => api.projects.list()),
  );

  server.registerTool(
    "create_ticket_from_messages",
    {
      title: "Create a ticket from messages",
      description:
        "Create a ticket in a project, built from chat messages (the feedback text and its screenshots). Title and description " +
        "default to the quoted messages; the status defaults to triage; the authors are notified. Fails with already_linked if a " +
        "message already backs another ticket. Only call after the user approved the plan.",
      inputSchema: {
        project: z.string().describe("Project key, e.g. APP"),
        message_ids: z.array(z.string()).min(1).max(50),
        title: z.string().max(300).optional().describe("Short, specific title (recommended)"),
        description: z.string().optional().describe("Markdown; defaults to a quote of the messages"),
        priority: priority.optional(),
        status: status.optional(),
        labels: z.array(z.string()).optional().describe("Label names"),
        assignee: z.string().optional().describe('"me", a user id or an email'),
        force: z.boolean().optional(),
      },
      annotations: WRITE,
    },
    ({ message_ids, ...b }) => call(() => api.tickets.create({ ...b, source_message_ids: message_ids })),
  );

  server.registerTool(
    "link_messages_to_ticket",
    {
      title: "Link messages to a ticket",
      description: "Attach more messages to an existing ticket (a precision or a screenshot posted later, a duplicate report).",
      inputSchema: { ticket: ticketRef, message_ids: z.array(z.string()).min(1).max(50), force: z.boolean().optional() },
      annotations: { ...WRITE, idempotentHint: true },
    },
    ({ ticket, message_ids, force }) => call(() => api.tickets.link(ticket, message_ids, force)),
  );

  server.registerTool(
    "list_tickets",
    {
      title: "List tickets",
      description: "Tickets the user can read, most recently updated first.",
      inputSchema: {
        project: z.string().optional().describe("Project key"),
        status: z.string().optional().describe('Comma-separated statuses, or "open"'),
        assignee: z.string().optional().describe('"me", "none", a user id or an email'),
        label: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().optional(),
      },
      annotations: READ,
    },
    (q) => call(() => api.tickets.list(q)),
  );

  server.registerTool(
    "get_ticket",
    {
      title: "Get a ticket",
      description: "A ticket with its description, source messages (with screenshots), comments and linked documents.",
      inputSchema: { ticket: ticketRef },
      annotations: READ,
    },
    ({ ticket }) => call(() => api.tickets.get(ticket)),
  );

  server.registerTool(
    "update_ticket",
    {
      title: "Update a ticket",
      description: "Change a ticket's title, description, status, priority, assignee, labels (replaces the set) or project.",
      inputSchema: {
        ticket: ticketRef,
        title: z.string().max(300).optional(),
        description: z.string().optional(),
        status: status.optional(),
        priority: priority.optional(),
        assignee: z.string().nullable().optional(),
        labels: z.array(z.string()).optional(),
        project: z.string().optional().describe("Moving gives the ticket a new key"),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    ({ ticket, ...b }) => call(() => api.tickets.update(ticket, b)),
  );

  server.registerTool(
    "add_comment",
    {
      title: "Comment on a ticket",
      description: "Add a comment to a ticket (followers are notified). Mention people with <@userId>.",
      inputSchema: { ticket: ticketRef, body: z.string().min(1) },
      annotations: WRITE,
    },
    ({ ticket, body }) => call(() => api.tickets.comment(ticket, body)),
  );

  server.registerTool(
    "search_docs",
    {
      title: "Search documents",
      description: "Search the knowledge base (processes, runbooks, onboarding…) among the documents the user can read.",
      inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(50).optional() },
      annotations: READ,
    },
    ({ query, limit }) => call(() => api.docs.search(query, limit)),
  );

  server.registerTool(
    "read_doc",
    {
      title: "Read a document",
      description:
        "A knowledge-base document: markdown content, version (pass it as base_version to update_doc) and the user's access level.",
      inputSchema: { doc_id: z.string() },
      annotations: READ,
    },
    ({ doc_id }) => call(() => api.docs.get(doc_id)),
  );

  server.registerTool(
    "update_doc",
    {
      title: "Update a document",
      description:
        "Save a new version of a document (edit access needed). Pass the version you read as base_version: if someone saved in " +
        "between, it fails with doc_conflict — read again and merge. Content replaces the whole document.",
      inputSchema: {
        doc_id: z.string(),
        content: z.string(),
        base_version: z.number().int().min(1),
        title: z.string().max(200).optional(),
      },
      annotations: { ...WRITE, destructiveHint: true },
    },
    ({ doc_id, ...b }) => call(() => api.docs.update(doc_id, b)),
  );

  return server;
}
