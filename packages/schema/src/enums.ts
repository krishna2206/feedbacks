import { z } from "zod";

/* Enumerations stored as text columns. The Zod schemas validate mutator arguments. */

export const orgRole = z.enum(["owner", "admin", "member"]);
export type OrgRole = z.infer<typeof orgRole>;

export const projectRole = z.enum(["lead", "contributor", "reporter", "viewer"]);
export type ProjectRole = z.infer<typeof projectRole>;

/** "org": every organization member can read the project (implicit viewer); "members": project members only */
export const projectVisibility = z.enum(["org", "members"]);
export type ProjectVisibility = z.infer<typeof projectVisibility>;

export const channelKind = z.enum(["public", "private", "dm"]);
export type ChannelKind = z.infer<typeof channelKind>;

export const attachmentKind = z.enum(["image", "file", "audio"]);
export type AttachmentKind = z.infer<typeof attachmentKind>;

export const ticketStatus = z.enum(["triage", "backlog", "todo", "in_progress", "in_review", "done", "canceled"]);
export type TicketStatus = z.infer<typeof ticketStatus>;

/** 0 none · 1 urgent · 2 high · 3 medium · 4 low */
export const ticketPriority = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type TicketPriority = z.infer<typeof ticketPriority>;

/** Where a ticket was created: the web app, the REST API (CLI, scripts) or the MCP server (agents) */
export const createdVia = z.enum(["app", "api", "mcp"]);
export type CreatedVia = z.infer<typeof createdVia>;

export const activityKind = z.enum([
  "created",
  "status",
  "priority",
  "assignee",
  "title",
  "description",
  "labels",
  "project",
  "linked_messages",
  "unlinked_messages",
]);
export type ActivityKind = z.infer<typeof activityKind>;

export const notificationKind = z.enum([
  "mention",
  "ticket_assigned",
  "ticket_status",
  "ticket_from_my_message",
  "comment",
  "access_request",
]);
export type NotificationKind = z.infer<typeof notificationKind>;

export const principalType = z.enum(["org", "team", "user"]);
export type PrincipalType = z.infer<typeof principalType>;

export const accessLevel = z.enum(["read", "edit", "manage"]);
export type AccessLevel = z.infer<typeof accessLevel>;
