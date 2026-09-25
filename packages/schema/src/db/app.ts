/**
 * Application tables. Conventions:
 * - Primary keys are client-generated string ids (see `src/ids.ts`), so Zero can create rows optimistically.
 * - Every business table carries `organization_id`: one instance can host several organizations.
 * - Zero cannot apply Postgres defaults from the client, so mutators always pass every non-null column.
 *   Defaults below only help server-side scripts (seed, migrations).
 * - Enumerations are plain `text` columns validated by Zod in mutators (see `src/enums.ts`).
 */
import { boolean, index, integer, pgTable, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";
import type {
  AccessLevel,
  ActivityKind,
  AttachmentKind,
  ChannelKind,
  CreatedVia,
  NotificationKind,
  PrincipalType,
  ProjectRole,
  TicketPriority,
  TicketStatus,
} from "../enums";
import { organization, user } from "./auth";
import { timestampTz } from "./columns";

const orgId = () =>
  text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" });
const userRef = (name: string) => text(name).references(() => user.id, { onDelete: "set null" });
const createdAt = () => timestampTz("created_at").defaultNow().notNull();

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

export const project = pgTable(
  "project",
  {
    id: text("id").primaryKey(),
    organizationId: orgId(),
    /** Ticket prefix, e.g. "APP" → APP-42 */
    key: text("key").notNull(),
    name: text("name").notNull(),
    color: text("color").notNull(),
    /** Last ticket number handed out (server-side counter) */
    ticketCounter: integer("ticket_counter").notNull().default(0),
    createdAt: createdAt(),
    archivedAt: timestampTz("archived_at"),
  },
  (t) => [uniqueIndex("project_org_key_uq").on(t.organizationId, t.key)],
);

export const projectMember = pgTable(
  "project_member",
  {
    id: text("id").primaryKey(),
    organizationId: orgId(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").$type<ProjectRole>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("project_member_uq").on(t.projectId, t.userId), index("project_member_user_idx").on(t.userId)],
);

export const label = pgTable(
  "label",
  {
    id: text("id").primaryKey(),
    organizationId: orgId(),
    name: text("name").notNull(),
    color: text("color").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("label_org_idx").on(t.organizationId)],
);

/* ------------------------------------------------------------------ */
/* Chat                                                                */
/* ------------------------------------------------------------------ */

export const channel = pgTable(
  "channel",
  {
    id: text("id").primaryKey(),
    organizationId: orgId(),
    kind: text("kind").$type<ChannelKind>().notNull(),
    /** Empty for direct messages (derived from the other member) */
    name: text("name").notNull(),
    topic: text("topic"),
    /** Default project proposed when converting messages to tickets (optional) */
    projectId: text("project_id").references(() => project.id, { onDelete: "set null" }),
    createdBy: userRef("created_by"),
    createdAt: createdAt(),
    archivedAt: timestampTz("archived_at"),
    /**
     * Sequence of the last top-level message (allocated by the server in `messages.send`).
     * Unread count = channel.last_seq - channel_member.last_read_seq: O(1), no COUNT query.
     */
    lastSeq: integer("last_seq").notNull().default(0),
    lastMessageAt: timestampTz("last_message_at"),
  },
  (t) => [
    // Sidebar lists: channels by name, direct messages by latest activity
    index("channel_org_idx").on(t.organizationId, t.kind, t.lastMessageAt, t.id),
    index("channel_org_name_idx").on(t.organizationId, t.name, t.id),
  ],
);

export const channelMember = pgTable(
  "channel_member",
  {
    id: text("id").primaryKey(),
    organizationId: orgId(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channel.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    lastReadAt: timestampTz("last_read_at"),
    /** Highest channel sequence the member has seen (see channel.last_seq) */
    lastReadSeq: integer("last_read_seq").notNull().default(0),
    joinedAt: createdAt(),
  },
  (t) => [
    uniqueIndex("channel_member_uq").on(t.channelId, t.userId),
    index("channel_member_channel_idx").on(t.channelId, t.id),
    index("channel_member_user_idx").on(t.userId),
  ],
);

export const message = pgTable(
  "message",
  {
    id: text("id").primaryKey(),
    organizationId: orgId(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channel.id, { onDelete: "cascade" }),
    authorId: userRef("author_id"),
    /** Set when the message is a reply in a thread */
    parentId: text("parent_id"),
    /** Mentions are stored as `<@userId>` tokens and rendered as @Name */
    body: text("body").notNull(),
    /** Position in the channel (top-level messages only; null for thread replies) */
    seq: integer("seq"),
    /** Thread summary kept on the parent so lists never count replies */
    replyCount: integer("reply_count").notNull().default(0),
    lastReplyAt: timestampTz("last_reply_at"),
    createdAt: createdAt(),
    editedAt: timestampTz("edited_at"),
    deletedAt: timestampTz("deleted_at"),
  },
  (t) => [
    // Zero always appends the primary key to ORDER BY: indexes end with `id`
    index("message_channel_created_idx").on(t.channelId, t.createdAt, t.id),
    index("message_parent_idx").on(t.parentId, t.createdAt, t.id),
    index("message_author_idx").on(t.authorId),
  ],
);

export const attachment = pgTable(
  "attachment",
  {
    id: text("id").primaryKey(),
    organizationId: orgId(),
    /** Null while the upload is not yet attached to a sent message */
    messageId: text("message_id").references(() => message.id, { onDelete: "cascade" }),
    /** Channel the file was uploaded to (access checks, including before the message is sent) */
    channelId: text("channel_id").references(() => channel.id, { onDelete: "cascade" }),
    kind: text("kind").$type<AttachmentKind>().notNull(),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    /** Object key in S3-compatible storage */
    storageKey: text("storage_key").notNull(),
    /** Small WebP preview generated client-side before upload (images only) */
    thumbKey: text("thumb_key"),
    width: integer("width"),
    height: integer("height"),
    uploadedBy: userRef("uploaded_by"),
    createdAt: createdAt(),
  },
  (t) => [index("attachment_message_idx").on(t.messageId, t.createdAt, t.id)],
);

export const reaction = pgTable(
  "reaction",
  {
    id: text("id").primaryKey(),
    organizationId: orgId(),
    messageId: text("message_id").references(() => message.id, { onDelete: "cascade" }),
    commentId: text("comment_id").references(() => comment.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("reaction_message_uq").on(t.messageId, t.userId, t.emoji),
    index("reaction_message_created_idx").on(t.messageId, t.createdAt, t.id),
    uniqueIndex("reaction_comment_uq").on(t.commentId, t.userId, t.emoji),
  ],
);

/* ------------------------------------------------------------------ */
/* Tickets                                                             */
/* ------------------------------------------------------------------ */

export const ticket = pgTable(
  "ticket",
  {
    id: text("id").primaryKey(),
    organizationId: orgId(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    /** Sequential per project, assigned by the server mutator */
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status").$type<TicketStatus>().notNull(),
    priority: integer("priority").$type<TicketPriority>().notNull().default(0),
    assigneeId: userRef("assignee_id"),
    creatorId: userRef("creator_id"),
    createdVia: text("created_via").$type<CreatedVia>().notNull().default("app"),
    createdAt: createdAt(),
    updatedAt: timestampTz("updated_at").defaultNow().notNull(),
    completedAt: timestampTz("completed_at"),
  },
  (t) => [
    uniqueIndex("ticket_project_number_uq").on(t.projectId, t.number),
    index("ticket_org_status_idx").on(t.organizationId, t.status),
    index("ticket_assignee_idx").on(t.assigneeId),
  ],
);

export const ticketLabel = pgTable(
  "ticket_label",
  {
    organizationId: orgId(),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => ticket.id, { onDelete: "cascade" }),
    labelId: text("label_id")
      .notNull()
      .references(() => label.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.ticketId, t.labelId] }), index("ticket_label_label_idx").on(t.labelId)],
);

/** N:N link between a ticket and the chat messages it was built from */
export const ticketSource = pgTable(
  "ticket_source",
  {
    organizationId: orgId(),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => ticket.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => message.id, { onDelete: "cascade" }),
    addedBy: userRef("added_by"),
    addedAt: timestampTz("added_at").defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.ticketId, t.messageId] }), index("ticket_source_message_idx").on(t.messageId)],
);

export const comment = pgTable(
  "comment",
  {
    id: text("id").primaryKey(),
    organizationId: orgId(),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => ticket.id, { onDelete: "cascade" }),
    authorId: userRef("author_id"),
    body: text("body").notNull(),
    createdAt: createdAt(),
    editedAt: timestampTz("edited_at"),
  },
  (t) => [index("comment_ticket_idx").on(t.ticketId, t.createdAt)],
);

export const activity = pgTable(
  "activity",
  {
    id: text("id").primaryKey(),
    organizationId: orgId(),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => ticket.id, { onDelete: "cascade" }),
    actorId: userRef("actor_id"),
    kind: text("kind").$type<ActivityKind>().notNull(),
    fromValue: text("from_value"),
    toValue: text("to_value"),
    createdAt: createdAt(),
  },
  (t) => [index("activity_ticket_idx").on(t.ticketId, t.createdAt)],
);

export const notification = pgTable(
  "notification",
  {
    id: text("id").primaryKey(),
    organizationId: orgId(),
    /** Recipient */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    actorId: userRef("actor_id"),
    kind: text("kind").$type<NotificationKind>().notNull(),
    ticketId: text("ticket_id").references(() => ticket.id, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => message.id, { onDelete: "cascade" }),
    channelId: text("channel_id").references(() => channel.id, { onDelete: "cascade" }),
    docId: text("doc_id").references(() => doc.id, { onDelete: "cascade" }),
    folderId: text("folder_id").references(() => docFolder.id, { onDelete: "cascade" }),
    body: text("body").notNull().default(""),
    createdAt: createdAt(),
    readAt: timestampTz("read_at"),
  },
  (t) => [index("notification_user_idx").on(t.userId, t.createdAt)],
);

/* ------------------------------------------------------------------ */
/* Knowledge base                                                      */
/* ------------------------------------------------------------------ */

export const docFolder = pgTable(
  "doc_folder",
  {
    id: text("id").primaryKey(),
    organizationId: orgId(),
    parentId: text("parent_id"),
    name: text("name").notNull(),
    /** false = uses its own grants instead of inheriting from the parent */
    inheritGrants: boolean("inherit_grants").notNull().default(true),
    createdBy: userRef("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("doc_folder_parent_idx").on(t.organizationId, t.parentId)],
);

export const doc = pgTable(
  "doc",
  {
    id: text("id").primaryKey(),
    organizationId: orgId(),
    folderId: text("folder_id").references(() => docFolder.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    /** Markdown */
    content: text("content").notNull().default(""),
    inheritGrants: boolean("inherit_grants").notNull().default(true),
    /** Where the document was imported from, e.g. "drive:Company/Operations/Refunds" */
    source: text("source"),
    createdBy: userRef("created_by"),
    createdAt: createdAt(),
    updatedBy: userRef("updated_by"),
    updatedAt: timestampTz("updated_at").defaultNow().notNull(),
  },
  (t) => [index("doc_folder_idx").on(t.folderId)],
);

export const docVersion = pgTable(
  "doc_version",
  {
    id: text("id").primaryKey(),
    organizationId: orgId(),
    docId: text("doc_id")
      .notNull()
      .references(() => doc.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    content: text("content").notNull(),
    authorId: userRef("author_id"),
    createdAt: createdAt(),
  },
  (t) => [index("doc_version_doc_idx").on(t.docId, t.createdAt)],
);

/** Access to a folder or a document for the whole org, a team or a user */
export const accessGrant = pgTable(
  "access_grant",
  {
    id: text("id").primaryKey(),
    organizationId: orgId(),
    folderId: text("folder_id").references(() => docFolder.id, { onDelete: "cascade" }),
    docId: text("doc_id").references(() => doc.id, { onDelete: "cascade" }),
    principalType: text("principal_type").$type<PrincipalType>().notNull(),
    /** Team or user id; null when principalType = "org" */
    principalId: text("principal_id"),
    level: text("level").$type<AccessLevel>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("access_grant_folder_idx").on(t.folderId), index("access_grant_doc_idx").on(t.docId)],
);

/* ------------------------------------------------------------------ */
/* Internal (never synced)                                             */
/* ------------------------------------------------------------------ */

/**
 * Files to delete from storage. Filled by a trigger whenever an `attachment` row is deleted
 * (message deletion, channel/organization cascades, pending-upload sweeps), drained by the API.
 * Failed deletions stay here with a backoff until the sweeper succeeds.
 */
export const storageDeletion = pgTable(
  "storage_deletion",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    key: text("key").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: createdAt(),
    nextAttemptAt: timestampTz("next_attempt_at").defaultNow().notNull(),
  },
  (t) => [index("storage_deletion_due_idx").on(t.nextAttemptAt, t.id)],
);
