CREATE TABLE "notification_setting" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"muted_kinds" json DEFAULT '[]'::json NOT NULL,
	"browser_enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_doc" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"entity_id" text NOT NULL,
	"channel_id" text,
	"project_id" text,
	"ticket_id" text,
	"author_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"tsv" "tsvector" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_setting" ADD CONSTRAINT "notification_setting_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_setting" ADD CONSTRAINT "notification_setting_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_doc" ADD CONSTRAINT "search_doc_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_setting_user_org_uq" ON "notification_setting" USING btree ("user_id","organization_id");--> statement-breakpoint
CREATE INDEX "search_doc_tsv_idx" ON "search_doc" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "search_doc_org_idx" ON "search_doc" USING btree ("organization_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "notification_panel_idx" ON "notification" USING btree ("user_id","organization_id","archived_at","created_at","id");--> statement-breakpoint
CREATE INDEX "notification_unread_idx" ON "notification" USING btree ("user_id","organization_id","archived_at","read_at","created_at","id");--> statement-breakpoint
-- Notification preferences are synced (each user reads their own row)
ALTER PUBLICATION "zero_data" ADD TABLE "notification_setting";--> statement-breakpoint
-- Full-text search: `simple` configuration (no stemming, no stop words: works for every language) over text
-- folded by `search_fold` = `unaccent` when the extension is available (it ships with the official Postgres
-- images). `simple` lowercases, so matching ignores case and accents. Without unaccent, search still works
-- but stays accent-sensitive.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS unaccent;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'unaccent unavailable: full-text search stays accent-sensitive';
  END;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'unaccent') THEN
    EXECUTE $f$CREATE FUNCTION "search_fold"(t text) RETURNS text LANGUAGE sql STABLE PARALLEL SAFE
      AS 'SELECT unaccent(''unaccent'', coalesce(t, ''''))'$f$;
  ELSE
    EXECUTE $f$CREATE FUNCTION "search_fold"(t text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
      AS 'SELECT coalesce(t, '''')'$f$;
  END IF;
END
$$;--> statement-breakpoint
-- `<@userId>` mention tokens become "@Name", so searching a person's name finds the messages mentioning them
CREATE FUNCTION "search_render_mentions"(body text) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE
  r record;
  result text := body;
BEGIN
  FOR r IN SELECT DISTINCT m[1] AS uid FROM regexp_matches(body, '<@([A-Za-z0-9_-]{1,64})>', 'g') AS m LOOP
    result := replace(result, '<@' || r.uid || '>', '@' || coalesce((SELECT u.name FROM "user" u WHERE u.id = r.uid), 'unknown'));
  END LOOP;
  RETURN result;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "search_upsert"(
  p_id text, p_org text, p_kind text, p_entity text, p_channel text, p_project text, p_ticket text,
  p_author text, p_created timestamptz, p_title text, p_body text
) RETURNS void LANGUAGE sql AS $$
  INSERT INTO "search_doc" ("id", "organization_id", "kind", "entity_id", "channel_id", "project_id", "ticket_id",
                            "author_id", "created_at", "title", "body", "tsv")
  VALUES (p_id, p_org, p_kind, p_entity, p_channel, p_project, p_ticket, p_author, p_created,
          coalesce(p_title, ''), coalesce(p_body, ''),
          setweight(to_tsvector('simple', "search_fold"(p_title)), 'A')
            || setweight(to_tsvector('simple', "search_fold"(p_body)), 'B'))
  ON CONFLICT ("id") DO UPDATE SET
    "channel_id" = excluded."channel_id", "project_id" = excluded."project_id", "ticket_id" = excluded."ticket_id",
    "author_id" = excluded."author_id", "title" = excluded."title", "body" = excluded."body", "tsv" = excluded."tsv";
$$;--> statement-breakpoint
-- Messages: indexed while they have text and aren't deleted (deleting = gone from search too)
CREATE FUNCTION "search_index_message"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM "search_doc" WHERE "id" = 'message:' || OLD."id";
    RETURN OLD;
  END IF;
  IF NEW."deleted_at" IS NOT NULL OR btrim(NEW."body") = '' THEN
    DELETE FROM "search_doc" WHERE "id" = 'message:' || NEW."id";
    RETURN NEW;
  END IF;
  PERFORM "search_upsert"('message:' || NEW."id", NEW."organization_id", 'message', NEW."id", NEW."channel_id", NULL, NULL,
                          NEW."author_id", NEW."created_at", '', "search_render_mentions"(NEW."body"));
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "search_message" AFTER INSERT OR DELETE OR UPDATE OF "body", "deleted_at" ON "message"
  FOR EACH ROW EXECUTE FUNCTION "search_index_message"();--> statement-breakpoint
-- Tickets: key + title weigh more than the description. The key is indexed as "APP 12": the parser reads
-- "APP-12" as "APP" and the integer "-12", which a search for "APP-12" (words "app" + "12") wouldn't match.
CREATE FUNCTION "search_index_ticket"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  k text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM "search_doc" WHERE "id" = 'ticket:' || OLD."id";
    RETURN OLD;
  END IF;
  SELECT p."key" INTO k FROM "project" p WHERE p."id" = NEW."project_id";
  PERFORM "search_upsert"('ticket:' || NEW."id", NEW."organization_id", 'ticket', NEW."id", NULL, NEW."project_id", NEW."id",
                          NEW."creator_id", NEW."created_at", coalesce(k, '') || ' ' || NEW."number" || ' ' || NEW."title",
                          NEW."description");
  -- Comments follow their ticket to another project
  IF TG_OP = 'UPDATE' AND NEW."project_id" IS DISTINCT FROM OLD."project_id" THEN
    UPDATE "search_doc" SET "project_id" = NEW."project_id" WHERE "ticket_id" = NEW."id" AND "kind" = 'comment';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "search_ticket" AFTER INSERT OR DELETE OR UPDATE OF "title", "description", "project_id", "number" ON "ticket"
  FOR EACH ROW EXECUTE FUNCTION "search_index_ticket"();--> statement-breakpoint
CREATE FUNCTION "search_index_comment"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pid text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM "search_doc" WHERE "id" = 'comment:' || OLD."id";
    RETURN OLD;
  END IF;
  SELECT t."project_id" INTO pid FROM "ticket" t WHERE t."id" = NEW."ticket_id";
  PERFORM "search_upsert"('comment:' || NEW."id", NEW."organization_id", 'comment', NEW."id", NULL, pid, NEW."ticket_id",
                          NEW."author_id", NEW."created_at", '', "search_render_mentions"(NEW."body"));
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "search_comment" AFTER INSERT OR DELETE OR UPDATE OF "body" ON "comment"
  FOR EACH ROW EXECUTE FUNCTION "search_index_comment"();--> statement-breakpoint
-- Backfill existing rows
SELECT "search_upsert"('message:' || m."id", m."organization_id", 'message', m."id", m."channel_id", NULL, NULL, m."author_id",
                       m."created_at", '', "search_render_mentions"(m."body"))
  FROM "message" m WHERE m."deleted_at" IS NULL AND btrim(m."body") <> '';--> statement-breakpoint
SELECT "search_upsert"('ticket:' || t."id", t."organization_id", 'ticket', t."id", NULL, t."project_id", t."id", t."creator_id",
                       t."created_at", p."key" || ' ' || t."number" || ' ' || t."title", t."description")
  FROM "ticket" t JOIN "project" p ON p."id" = t."project_id";--> statement-breakpoint
SELECT "search_upsert"('comment:' || c."id", c."organization_id", 'comment', c."id", NULL, t."project_id", c."ticket_id",
                       c."author_id", c."created_at", '', "search_render_mentions"(c."body"))
  FROM "comment" c JOIN "ticket" t ON t."id" = c."ticket_id";
