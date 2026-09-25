CREATE TABLE "ticket_alias" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"number" integer NOT NULL,
	"ticket_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "ticket_org_status_idx";--> statement-breakpoint
DROP INDEX "activity_ticket_idx";--> statement-breakpoint
DROP INDEX "comment_ticket_idx";--> statement-breakpoint
DROP INDEX "label_org_idx";--> statement-breakpoint
DROP INDEX "notification_user_idx";--> statement-breakpoint
DROP INDEX "ticket_assignee_idx";--> statement-breakpoint
DROP INDEX "ticket_label_label_idx";--> statement-breakpoint
DROP INDEX "ticket_source_message_idx";--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "ticket_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "visibility" text DEFAULT 'org' NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "ticket_alias" ADD CONSTRAINT "ticket_alias_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_alias" ADD CONSTRAINT "ticket_alias_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_alias" ADD CONSTRAINT "ticket_alias_ticket_id_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."ticket"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_alias_project_number_uq" ON "ticket_alias" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "ticket_alias_ticket_idx" ON "ticket_alias" USING btree ("ticket_id","id");--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "label_org_name_uq" ON "label" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "message_channel_unprocessed_idx" ON "message" USING btree ("channel_id","ticket_count","created_at","id");--> statement-breakpoint
CREATE INDEX "project_org_name_idx" ON "project" USING btree ("organization_id","name","id");--> statement-breakpoint
CREATE INDEX "project_member_project_idx" ON "project_member" USING btree ("project_id","created_at","id");--> statement-breakpoint
CREATE INDEX "reaction_comment_created_idx" ON "reaction" USING btree ("comment_id","created_at","id");--> statement-breakpoint
CREATE INDEX "ticket_project_updated_idx" ON "ticket" USING btree ("project_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "ticket_org_updated_idx" ON "ticket" USING btree ("organization_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "ticket_creator_idx" ON "ticket" USING btree ("creator_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "ticket_source_ticket_idx" ON "ticket_source" USING btree ("ticket_id","added_at","message_id");--> statement-breakpoint
CREATE INDEX "activity_ticket_idx" ON "activity" USING btree ("ticket_id","created_at","id");--> statement-breakpoint
CREATE INDEX "comment_ticket_idx" ON "comment" USING btree ("ticket_id","created_at","id");--> statement-breakpoint
CREATE INDEX "label_org_idx" ON "label" USING btree ("organization_id","name","id");--> statement-breakpoint
CREATE INDEX "notification_user_idx" ON "notification" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "ticket_assignee_idx" ON "ticket" USING btree ("assignee_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "ticket_label_label_idx" ON "ticket_label" USING btree ("label_id","ticket_id");--> statement-breakpoint
CREATE INDEX "ticket_source_message_idx" ON "ticket_source" USING btree ("message_id","ticket_id");--> statement-breakpoint
-- Former keys of moved tickets are synced (links to an old key keep working)
ALTER PUBLICATION "zero_data" ADD TABLE "ticket_alias";--> statement-breakpoint
-- message.ticket_count follows ticket_source on every path (mutators, cascades, scripts):
-- the "unprocessed" tab filters on ticket_count = 0 instead of an anti-join
CREATE FUNCTION "count_message_tickets"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE "message" SET "ticket_count" = "ticket_count" + 1 WHERE "id" = NEW."message_id";
    RETURN NEW;
  END IF;
  UPDATE "message" SET "ticket_count" = greatest("ticket_count" - 1, 0) WHERE "id" = OLD."message_id";
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "ticket_source_count" AFTER INSERT OR DELETE ON "ticket_source"
  FOR EACH ROW EXECUTE FUNCTION "count_message_tickets"();
