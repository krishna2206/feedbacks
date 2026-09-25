CREATE TABLE "storage_deletion" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "storage_deletion_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"key" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "attachment_message_idx";--> statement-breakpoint
DROP INDEX "channel_org_idx";--> statement-breakpoint
DROP INDEX "message_channel_created_idx";--> statement-breakpoint
DROP INDEX "message_parent_idx";--> statement-breakpoint
ALTER TABLE "attachment" ADD COLUMN "channel_id" text;--> statement-breakpoint
ALTER TABLE "attachment" ADD COLUMN "thumb_key" text;--> statement-breakpoint
ALTER TABLE "channel" ADD COLUMN "last_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "channel" ADD COLUMN "last_message_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel_member" ADD COLUMN "last_read_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "seq" integer;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "reply_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "last_reply_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "storage_deletion_due_idx" ON "storage_deletion" USING btree ("next_attempt_at","id");--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_org_name_idx" ON "channel" USING btree ("organization_id","name","id");--> statement-breakpoint
CREATE INDEX "channel_member_channel_idx" ON "channel_member" USING btree ("channel_id","id");--> statement-breakpoint
CREATE INDEX "reaction_message_created_idx" ON "reaction" USING btree ("message_id","created_at","id");--> statement-breakpoint
CREATE INDEX "member_org_user_idx" ON "member" USING btree ("organization_id","user_id","id");--> statement-breakpoint
CREATE INDEX "attachment_message_idx" ON "attachment" USING btree ("message_id","created_at","id");--> statement-breakpoint
CREATE INDEX "channel_org_idx" ON "channel" USING btree ("organization_id","kind","last_message_at","id");--> statement-breakpoint
CREATE INDEX "message_channel_created_idx" ON "message" USING btree ("channel_id","created_at","id");--> statement-breakpoint
CREATE INDEX "message_parent_idx" ON "message" USING btree ("parent_id","created_at","id");--> statement-breakpoint
-- Deleted attachments = deleted files: whatever removes an attachment row (message deletion,
-- channel or organization cascade, pending-upload sweep) queues its files for the API to delete.
CREATE FUNCTION "queue_attachment_files"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "storage_deletion" ("key") VALUES (OLD."storage_key");
  IF OLD."thumb_key" IS NOT NULL THEN
    INSERT INTO "storage_deletion" ("key") VALUES (OLD."thumb_key");
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "attachment_files_cleanup" AFTER DELETE ON "attachment"
  FOR EACH ROW EXECUTE FUNCTION "queue_attachment_files"();
