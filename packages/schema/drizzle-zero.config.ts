import { drizzleZeroConfig } from "drizzle-zero";
import * as drizzleSchema from "./src/db/schema";

/**
 * Tables and columns synced to clients. Secrets never leave Postgres:
 * session / account / verification are excluded, `user` only exposes public profile fields.
 * Keep in sync with the `zero_data` publication (migrations/…_zero_publication.sql).
 */
export default drizzleZeroConfig(drizzleSchema, {
  tables: {
    session: false,
    account: false,
    verification: false,
    user: { id: true, name: true, email: true, image: true, createdAt: true, updatedAt: true, emailVerified: false },
    organization: true,
    member: true,
    team: true,
    teamMember: true,
    invitation: true,
    project: true,
    projectMember: true,
    label: true,
    channel: true,
    channelMember: true,
    message: true,
    attachment: true,
    reaction: true,
    ticket: true,
    ticketLabel: true,
    ticketSource: true,
    comment: true,
    activity: true,
    notification: true,
    docFolder: true,
    doc: true,
    docVersion: true,
    accessGrant: true,
  },
});
