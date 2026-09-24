-- Tables and columns replicated to zero-cache (ZERO_APP_PUBLICATIONS=zero_data).
-- Secrets (session, account, verification, user.email_verified) never leave Postgres.
-- Keep in sync with drizzle-zero.config.ts; when adding a table, ALTER PUBLICATION in a new migration.
CREATE PUBLICATION "zero_data" FOR TABLE
  "user" ("id", "name", "email", "image", "created_at", "updated_at"),
  "organization", "member", "team", "team_member", "invitation",
  "project", "project_member", "label",
  "channel", "channel_member", "message", "attachment", "reaction",
  "ticket", "ticket_label", "ticket_source", "comment", "activity", "notification",
  "doc_folder", "doc", "doc_version", "access_grant";
