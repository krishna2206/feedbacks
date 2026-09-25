/**
 * Application tables. Conventions:
 * - Primary keys are client-generated string ids (see `src/ids.ts`), so Zero can create rows optimistically.
 * - Every business table carries `organization_id`: one instance can host several organizations.
 * - Zero cannot apply Postgres defaults from the client, so mutators always pass every non-null column.
 *   Defaults below only help server-side scripts (seed, migrations).
 * - Enumerations are plain `text` columns validated by Zod in mutators (see `src/enums.ts`).
 */
import { boolean, customType, doublePrecision, index, integer, json, pgTable, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";
import type {
  AccessLevel,
  ActivityKind,
  AttachmentKind,
  ChannelKind,
  CreatedVia,
  NotificationKind,
  PrincipalType,
  ProjectRole,
  ProjectVisibility,
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
    /** Who can read the project's tickets without being a project member (see ProjectVisibility) */
    visibility: text("visibility").$type<ProjectVisibility>().notNull().default("org"),
    /** Last ticket number handed out (server-side counter) */
    ticketCounter: integer("ticket_counter").notNull().default(0),
    createdBy: userRef("created_by"),
    createdAt: createdAt(),
    archivedAt: timestampTz("archived_at"),
  },
  (t) => [uniqueIndex("project_org_key_uq").on(t.organizationId, t.key), index("project_org_name_idx").on(t.organizationId, t.name, t.id)],
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
  (t) => [
    uniqueIndex("project_member_uq").on(t.projectId, t.userId),
    index("project_member_project_idx").on(t.projectId, t.createdAt, t.id),
    index("project_member_user_idx").on(t.userId),
  ],
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
  (t) => [uniqueIndex("label_org_name_uq").on(t.organizationId, t.name), index("label_org_idx").on(t.organizationId, t.name, t.id)],
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
    /** Number of tickets built from this message (maintained by a trigger on ticket_source); 0 = unprocessed */
    ticketCount: integer("ticket_count").notNull().default(0),
    lastReplyAt: timestampTz("last_reply_at"),
    /** Set when posted by an agent through the API/MCP: client label shown as "via …" (null = web app) */
    via: text("via"),
    createdAt: createdAt(),
    editedAt: timestampTz("edited_at"),
    deletedAt: timestampTz("deleted_at"),
  },
  (t) => [
    // Zero always appends the primary key to ORDER BY: indexes end with `id`
    index("message_channel_created_idx").on(t.channelId, t.createdAt, t.id),
    // "Unprocessed" tab: top-level messages without tickets, newest first
    index("message_channel_unprocessed_idx").on(t.channelId, t.ticketCount, t.createdAt, t.id),
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
    /** Document the file belongs to (images pasted in a document; access follows the document) */
    docId: text("doc_id").references(() => doc.id, { onDelete: "cascade" }),
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
    index("reaction_comment_created_idx").on(t.commentId, t.createdAt, t.id),
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
    index("ticket_project_updated_idx").on(t.projectId, t.updatedAt, t.id),
    // "Recent tickets" (link picker, command menu)
    index("ticket_org_updated_idx").on(t.organizationId, t.updatedAt, t.id),
    index("ticket_assignee_idx").on(t.assigneeId, t.updatedAt, t.id),
    index("ticket_creator_idx").on(t.creatorId, t.updatedAt, t.id),
  ],
);

/**
 * Former keys of tickets moved to another project: APP-12 moved to OPS becomes OPS-3,
 * and links to APP-12 keep working. Project counters never go back, so numbers are never reused.
 */
export const ticketAlias = pgTable(
  "ticket_alias",
  {
    /** `${projectId}:${number}` */
    id: text("id").primaryKey(),
    organizationId: orgId(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => ticket.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("ticket_alias_project_number_uq").on(t.projectId, t.number), index("ticket_alias_ticket_idx").on(t.ticketId, t.id)],
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
  (t) => [primaryKey({ columns: [t.ticketId, t.labelId] }), index("ticket_label_label_idx").on(t.labelId, t.ticketId)],
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
  (t) => [
    primaryKey({ columns: [t.ticketId, t.messageId] }),
    index("ticket_source_ticket_idx").on(t.ticketId, t.addedAt, t.messageId),
    index("ticket_source_message_idx").on(t.messageId, t.ticketId),
  ],
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
    /** Set when posted by an agent through the API/MCP: client label shown as "via …" (null = web app) */
    via: text("via"),
    createdAt: createdAt(),
    editedAt: timestampTz("edited_at"),
  },
  (t) => [index("comment_ticket_idx").on(t.ticketId, t.createdAt, t.id)],
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
  (t) => [index("activity_ticket_idx").on(t.ticketId, t.createdAt, t.id)],
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
    /** Hidden from the notification panel (kept for history) */
    archivedAt: timestampTz("archived_at"),
  },
  (t) => [
    index("notification_user_idx").on(t.userId, t.createdAt, t.id),
    // Panel ("all") and badge ("unread") of one organization, newest first
    index("notification_panel_idx").on(t.userId, t.organizationId, t.archivedAt, t.createdAt, t.id),
    index("notification_unread_idx").on(t.userId, t.organizationId, t.archivedAt, t.readAt, t.createdAt, t.id),
  ],
);

/** Per-user notification preferences in an organization (id = `${organizationId}:${userId}`) */
export const notificationSetting = pgTable(
  "notification_setting",
  {
    id: text("id").primaryKey(),
    organizationId: orgId(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Notification kinds the user doesn't want (never created for them) */
    mutedKinds: json("muted_kinds").$type<NotificationKind[]>().notNull().default([]),
    /** Desktop notifications through the browser Notification API (opt-in) */
    browserEnabled: boolean("browser_enabled").notNull().default(false),
    updatedAt: timestampTz("updated_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("notification_setting_user_org_uq").on(t.userId, t.organizationId)],
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
    /** false = "restricted": only its own grants apply; true = its grants add to the inherited ones */
    inheritGrants: boolean("inherit_grants").notNull().default(true),
    /** Manual order among siblings (fractional: moving an item only rewrites that item) */
    sortOrder: doublePrecision("sort_order").notNull().default(0),
    createdBy: userRef("created_by"),
    createdAt: createdAt(),
    updatedAt: timestampTz("updated_at").defaultNow().notNull(),
    /** Trash: set on the deleted folder and everything under it (restorable until purged) */
    deletedAt: timestampTz("deleted_at"),
    deletedBy: userRef("deleted_by"),
    /**
     * null on the item the user deleted (a "trash root"); on items trashed along with a folder, the id of
     * that folder: restoring or purging a root handles its whole subtree
     */
    trashRootId: text("trash_root_id"),
  },
  (t) => [index("doc_folder_parent_idx").on(t.organizationId, t.parentId), index("doc_folder_trash_idx").on(t.trashRootId)],
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
    /** Incremented by every save; a save based on an older version is a conflict (see docs.save) */
    version: integer("version").notNull().default(1),
    inheritGrants: boolean("inherit_grants").notNull().default(true),
    sortOrder: doublePrecision("sort_order").notNull().default(0),
    /** Where the document was imported from, e.g. "import:Handbook/Onboarding.md" */
    source: text("source"),
    createdBy: userRef("created_by"),
    createdAt: createdAt(),
    updatedBy: userRef("updated_by"),
    updatedAt: timestampTz("updated_at").defaultNow().notNull(),
    deletedAt: timestampTz("deleted_at"),
    deletedBy: userRef("deleted_by"),
    trashRootId: text("trash_root_id"),
  },
  (t) => [
    index("doc_folder_idx").on(t.folderId),
    index("doc_org_idx").on(t.organizationId, t.deletedAt),
    index("doc_trash_idx").on(t.trashRootId),
  ],
);

export const docVersion = pgTable(
  "doc_version",
  {
    id: text("id").primaryKey(),
    organizationId: orgId(),
    docId: text("doc_id")
      .notNull()
      .references(() => doc.id, { onDelete: "cascade" }),
    /** Value of `doc.version` after the save that produced this snapshot */
    number: integer("number").notNull().default(1),
    title: text("title").notNull(),
    content: text("content").notNull(),
    authorId: userRef("author_id"),
    createdAt: createdAt(),
  },
  (t) => [index("doc_version_doc_idx").on(t.docId, t.createdAt)],
);

/**
 * Access to a folder or a document for the whole org, a team or a user (id = `${nodeId}:${type}:${principalId ?? "org"}`).
 * Grants are additive to the inherited ones, unless the node is restricted (`inherit_grants = false`).
 * Never read directly for permission checks: `acl_entry` holds the resolved result.
 */
export const accessGrant = pgTable(
  "access_grant",
  {
    id: text("id").primaryKey(),
    organizationId: orgId(),
    /** The folder or document id (exactly one of folder_id / doc_id is set, and equals node_id) */
    nodeId: text("node_id").notNull(),
    folderId: text("folder_id").references(() => docFolder.id, { onDelete: "cascade" }),
    docId: text("doc_id").references(() => doc.id, { onDelete: "cascade" }),
    principalType: text("principal_type").$type<PrincipalType>().notNull(),
    /** Team or user id; null when principalType = "org" */
    principalId: text("principal_id"),
    level: text("level").$type<AccessLevel>().notNull(),
    createdBy: userRef("created_by"),
    createdAt: createdAt(),
  },
  (t) => [
    index("access_grant_folder_idx").on(t.folderId),
    index("access_grant_doc_idx").on(t.docId),
    index("access_grant_node_idx").on(t.nodeId, t.id),
  ],
);

/**
 * Effective access of every folder and document, resolved by triggers (migration 0005) from the grants,
 * the inheritance flags and the tree: own grants + inherited entries (unless restricted), highest level
 * per principal. Root-level nodes inherit the organization default ("edit" for every member).
 * Zero filters rows with it (no recursion in ZQL); the API uses it through `doc_access_level()`.
 * id = `${nodeId}:${principalType}:${principalId ?? "org"}`
 */
export const aclEntry = pgTable(
  "acl_entry",
  {
    id: text("id").primaryKey(),
    organizationId: orgId(),
    nodeId: text("node_id").notNull(),
    nodeKind: text("node_kind").$type<"folder" | "doc">().notNull(),
    principalType: text("principal_type").$type<PrincipalType>().notNull(),
    principalId: text("principal_id"),
    level: text("level").$type<AccessLevel>().notNull(),
  },
  (t) => [
    index("acl_entry_node_idx").on(t.nodeId, t.principalType, t.principalId),
    index("acl_entry_principal_idx").on(t.principalType, t.principalId),
  ],
);

/** A document linked to a ticket ("Related documents" / "Referenced by"), id = `${ticketId}:${docId}` */
export const docLink = pgTable(
  "doc_link",
  {
    id: text("id").primaryKey(),
    organizationId: orgId(),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => ticket.id, { onDelete: "cascade" }),
    docId: text("doc_id")
      .notNull()
      .references(() => doc.id, { onDelete: "cascade" }),
    createdBy: userRef("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("doc_link_ticket_idx").on(t.ticketId, t.createdAt, t.id), index("doc_link_doc_idx").on(t.docId, t.createdAt, t.id)],
);

/* ------------------------------------------------------------------ */
/* Internal (never synced)                                             */
/* ------------------------------------------------------------------ */

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

/**
 * Full-text search index (messages, tickets, comments; documents in M4). Maintained by triggers on
 * the source tables (see migration 0004), queried by `GET /api/search` with permission filters.
 * `tsv` = `simple` configuration over text folded by `search_fold` (unaccent): matching ignores case
 * and accents in every language.
 */
export const searchDoc = pgTable(
  "search_doc",
  {
    /** `${kind}:${entityId}` */
    id: text("id").primaryKey(),
    organizationId: orgId(),
    kind: text("kind").$type<"message" | "ticket" | "comment" | "doc">().notNull(),
    entityId: text("entity_id").notNull(),
    channelId: text("channel_id"),
    projectId: text("project_id"),
    ticketId: text("ticket_id"),
    authorId: text("author_id"),
    createdAt: timestampTz("created_at").notNull(),
    /** Ticket key + title, document title (weight A) */
    title: text("title").notNull().default(""),
    /** Message / comment body with mentions resolved to names, ticket description (weight B) */
    body: text("body").notNull().default(""),
    tsv: tsvector("tsv").notNull(),
  },
  (t) => [index("search_doc_tsv_idx").using("gin", t.tsv), index("search_doc_org_idx").on(t.organizationId, t.kind, t.createdAt)],
);

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

/* ------------------------------------------------------------------ */
/* Agents: personal access tokens and idempotent API writes (never synced) */
/* ------------------------------------------------------------------ */

/**
 * Personal access token of a member for one organization (REST API v1, CLI, MCP).
 * Only the SHA-256 of the secret is stored; the secret (`fbk_…`) is shown once at creation.
 * An agent using a token has exactly the permissions of its owner in that organization.
 */
export const apiToken = pgTable(
  "api_token",
  {
    id: text("id").primaryKey(),
    organizationId: orgId(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** hex SHA-256 of the full token */
    tokenHash: text("token_hash").notNull(),
    /** First characters of the token, shown in lists to recognize it (e.g. "fbk_3f9a") */
    prefix: text("prefix").notNull(),
    scope: text("scope").$type<"read" | "read-write">().notNull(),
    createdAt: createdAt(),
    expiresAt: timestampTz("expires_at"),
    lastUsedAt: timestampTz("last_used_at"),
    revokedAt: timestampTz("revoked_at"),
    revokedBy: userRef("revoked_by"),
  },
  (t) => [uniqueIndex("api_token_hash_uq").on(t.tokenHash), index("api_token_org_user_idx").on(t.organizationId, t.userId, t.createdAt)],
);

/**
 * Stored responses of API writes sent with an `Idempotency-Key` header (replayed for 24 h).
 * `status` null = request in progress.
 */
export const apiIdempotency = pgTable(
  "api_idempotency",
  {
    tokenId: text("token_id")
      .notNull()
      .references(() => apiToken.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    /** hex SHA-256 of method + path + body: the same key with another request is refused */
    requestHash: text("request_hash").notNull(),
    status: integer("status"),
    response: json("response"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.tokenId, t.key] }), index("api_idempotency_created_idx").on(t.createdAt)],
);
