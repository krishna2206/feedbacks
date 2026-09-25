/**
 * Single entry point of the Drizzle schema (required by drizzle-kit and drizzle-zero):
 * tables + relations. Relations also become Zero relationships.
 */
import { relations } from "drizzle-orm";
import {
  accessGrant,
  activity,
  attachment,
  channel,
  channelMember,
  comment,
  doc,
  docFolder,
  docVersion,
  label,
  message,
  notification,
  project,
  projectMember,
  reaction,
  ticket,
  ticketLabel,
  ticketSource,
} from "./app";
import { account, invitation, member, organization, session, team, teamMember, user, verification } from "./auth";

export * from "./app";
export * from "./auth";

/* ----------------------------- Identity ----------------------------- */

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  memberships: many(member),
  teamMemberships: many(teamMember),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

export const verificationRelations = relations(verification, () => ({}));

export const organizationRelations = relations(organization, ({ many }) => ({
  members: many(member),
  teams: many(team),
  invitations: many(invitation),
  projects: many(project),
  channels: many(channel),
  labels: many(label),
}));

export const memberRelations = relations(member, ({ one }) => ({
  organization: one(organization, { fields: [member.organizationId], references: [organization.id] }),
  user: one(user, { fields: [member.userId], references: [user.id] }),
}));

export const teamRelations = relations(team, ({ one, many }) => ({
  organization: one(organization, { fields: [team.organizationId], references: [organization.id] }),
  members: many(teamMember),
}));

export const teamMemberRelations = relations(teamMember, ({ one }) => ({
  team: one(team, { fields: [teamMember.teamId], references: [team.id] }),
  user: one(user, { fields: [teamMember.userId], references: [user.id] }),
}));

export const invitationRelations = relations(invitation, ({ one }) => ({
  organization: one(organization, { fields: [invitation.organizationId], references: [organization.id] }),
  inviter: one(user, { fields: [invitation.inviterId], references: [user.id] }),
}));

/* ----------------------------- Projects ----------------------------- */

export const projectRelations = relations(project, ({ one, many }) => ({
  organization: one(organization, { fields: [project.organizationId], references: [organization.id] }),
  members: many(projectMember),
  tickets: many(ticket),
}));

export const projectMemberRelations = relations(projectMember, ({ one }) => ({
  project: one(project, { fields: [projectMember.projectId], references: [project.id] }),
  user: one(user, { fields: [projectMember.userId], references: [user.id] }),
}));

export const labelRelations = relations(label, ({ one }) => ({
  organization: one(organization, { fields: [label.organizationId], references: [organization.id] }),
}));

/* ------------------------------- Chat ------------------------------- */

export const channelRelations = relations(channel, ({ one, many }) => ({
  organization: one(organization, { fields: [channel.organizationId], references: [organization.id] }),
  project: one(project, { fields: [channel.projectId], references: [project.id] }),
  members: many(channelMember),
  messages: many(message),
}));

export const channelMemberRelations = relations(channelMember, ({ one }) => ({
  channel: one(channel, { fields: [channelMember.channelId], references: [channel.id] }),
  user: one(user, { fields: [channelMember.userId], references: [user.id] }),
}));

export const messageRelations = relations(message, ({ one, many }) => ({
  channel: one(channel, { fields: [message.channelId], references: [channel.id] }),
  author: one(user, { fields: [message.authorId], references: [user.id] }),
  parent: one(message, { fields: [message.parentId], references: [message.id], relationName: "thread" }),
  replies: many(message, { relationName: "thread" }),
  attachments: many(attachment),
  reactions: many(reaction),
  ticketSources: many(ticketSource),
}));

export const attachmentRelations = relations(attachment, ({ one }) => ({
  message: one(message, { fields: [attachment.messageId], references: [message.id] }),
  channel: one(channel, { fields: [attachment.channelId], references: [channel.id] }),
}));

export const reactionRelations = relations(reaction, ({ one }) => ({
  message: one(message, { fields: [reaction.messageId], references: [message.id] }),
  comment: one(comment, { fields: [reaction.commentId], references: [comment.id] }),
  user: one(user, { fields: [reaction.userId], references: [user.id] }),
}));

/* ------------------------------ Tickets ----------------------------- */

export const ticketRelations = relations(ticket, ({ one, many }) => ({
  project: one(project, { fields: [ticket.projectId], references: [project.id] }),
  assignee: one(user, { fields: [ticket.assigneeId], references: [user.id], relationName: "assignee" }),
  creator: one(user, { fields: [ticket.creatorId], references: [user.id], relationName: "creator" }),
  labels: many(ticketLabel),
  sources: many(ticketSource),
  comments: many(comment),
  activities: many(activity),
}));

export const ticketLabelRelations = relations(ticketLabel, ({ one }) => ({
  ticket: one(ticket, { fields: [ticketLabel.ticketId], references: [ticket.id] }),
  label: one(label, { fields: [ticketLabel.labelId], references: [label.id] }),
}));

export const ticketSourceRelations = relations(ticketSource, ({ one }) => ({
  ticket: one(ticket, { fields: [ticketSource.ticketId], references: [ticket.id] }),
  message: one(message, { fields: [ticketSource.messageId], references: [message.id] }),
}));

export const commentRelations = relations(comment, ({ one, many }) => ({
  ticket: one(ticket, { fields: [comment.ticketId], references: [ticket.id] }),
  author: one(user, { fields: [comment.authorId], references: [user.id] }),
  reactions: many(reaction),
}));

export const activityRelations = relations(activity, ({ one }) => ({
  ticket: one(ticket, { fields: [activity.ticketId], references: [ticket.id] }),
  actor: one(user, { fields: [activity.actorId], references: [user.id] }),
}));

export const notificationRelations = relations(notification, ({ one }) => ({
  user: one(user, { fields: [notification.userId], references: [user.id], relationName: "recipient" }),
  actor: one(user, { fields: [notification.actorId], references: [user.id], relationName: "actor" }),
  ticket: one(ticket, { fields: [notification.ticketId], references: [ticket.id] }),
  message: one(message, { fields: [notification.messageId], references: [message.id] }),
  channel: one(channel, { fields: [notification.channelId], references: [channel.id] }),
}));

/* -------------------------- Knowledge base -------------------------- */

export const docFolderRelations = relations(docFolder, ({ one, many }) => ({
  parent: one(docFolder, { fields: [docFolder.parentId], references: [docFolder.id], relationName: "folderTree" }),
  children: many(docFolder, { relationName: "folderTree" }),
  docs: many(doc),
  grants: many(accessGrant),
}));

export const docRelations = relations(doc, ({ one, many }) => ({
  folder: one(docFolder, { fields: [doc.folderId], references: [docFolder.id] }),
  versions: many(docVersion),
  grants: many(accessGrant),
}));

export const docVersionRelations = relations(docVersion, ({ one }) => ({
  doc: one(doc, { fields: [docVersion.docId], references: [doc.id] }),
  author: one(user, { fields: [docVersion.authorId], references: [user.id] }),
}));

export const accessGrantRelations = relations(accessGrant, ({ one }) => ({
  folder: one(docFolder, { fields: [accessGrant.folderId], references: [docFolder.id] }),
  doc: one(doc, { fields: [accessGrant.docId], references: [doc.id] }),
}));
