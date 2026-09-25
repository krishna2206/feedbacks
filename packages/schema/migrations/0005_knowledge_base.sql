CREATE TABLE "acl_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"node_id" text NOT NULL,
	"node_kind" text NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text,
	"level" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_link" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"ticket_id" text NOT NULL,
	"doc_id" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_grant" ADD COLUMN "node_id" text;--> statement-breakpoint
UPDATE "access_grant" SET "node_id" = coalesce("folder_id", "doc_id");--> statement-breakpoint
DELETE FROM "access_grant" WHERE "node_id" IS NULL;--> statement-breakpoint
ALTER TABLE "access_grant" ALTER COLUMN "node_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "access_grant" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "attachment" ADD COLUMN "doc_id" text;--> statement-breakpoint
ALTER TABLE "doc" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "doc" ADD COLUMN "sort_order" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "doc" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "doc" ADD COLUMN "deleted_by" text;--> statement-breakpoint
ALTER TABLE "doc" ADD COLUMN "trash_root_id" text;--> statement-breakpoint
ALTER TABLE "doc_folder" ADD COLUMN "sort_order" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "doc_folder" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "doc_folder" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "doc_folder" ADD COLUMN "deleted_by" text;--> statement-breakpoint
ALTER TABLE "doc_folder" ADD COLUMN "trash_root_id" text;--> statement-breakpoint
ALTER TABLE "doc_version" ADD COLUMN "number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "acl_entry" ADD CONSTRAINT "acl_entry_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_link" ADD CONSTRAINT "doc_link_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_link" ADD CONSTRAINT "doc_link_ticket_id_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."ticket"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_link" ADD CONSTRAINT "doc_link_doc_id_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."doc"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_link" ADD CONSTRAINT "doc_link_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acl_entry_node_idx" ON "acl_entry" USING btree ("node_id","principal_type","principal_id");--> statement-breakpoint
CREATE INDEX "acl_entry_principal_idx" ON "acl_entry" USING btree ("principal_type","principal_id");--> statement-breakpoint
CREATE INDEX "doc_link_ticket_idx" ON "doc_link" USING btree ("ticket_id","created_at","id");--> statement-breakpoint
CREATE INDEX "doc_link_doc_idx" ON "doc_link" USING btree ("doc_id","created_at","id");--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_doc_id_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."doc"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc" ADD CONSTRAINT "doc_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_folder" ADD CONSTRAINT "doc_folder_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_grant_node_idx" ON "access_grant" USING btree ("node_id","id");--> statement-breakpoint
CREATE INDEX "doc_org_idx" ON "doc" USING btree ("organization_id","deleted_at");--> statement-breakpoint
CREATE INDEX "doc_trash_idx" ON "doc" USING btree ("trash_root_id");--> statement-breakpoint
CREATE INDEX "doc_folder_trash_idx" ON "doc_folder" USING btree ("trash_root_id");--> statement-breakpoint
ALTER PUBLICATION "zero_data" ADD TABLE "acl_entry", "doc_link";--> statement-breakpoint
-- Document bodies stay server-side: clients read the current version row (the tree syncs without bodies)
ALTER PUBLICATION "zero_data" DROP TABLE "doc";--> statement-breakpoint
ALTER PUBLICATION "zero_data" ADD TABLE "doc" ("id", "organization_id", "folder_id", "title", "version", "inherit_grants",
  "sort_order", "source", "created_by", "created_at", "updated_by", "updated_at", "deleted_at", "deleted_by", "trash_root_id");--> statement-breakpoint
-- Every document has a version row for its current version (the client reads its body from it)
INSERT INTO "doc_version" ("id", "organization_id", "doc_id", "number", "title", "content", "author_id", "created_at")
SELECT d."id" || ':v' || d."version", d."organization_id", d."id", d."version", d."title", d."content",
       coalesce(d."updated_by", d."created_by"), d."updated_at"
  FROM "doc" d
 WHERE NOT EXISTS (SELECT 1 FROM "doc_version" v WHERE v."doc_id" = d."id" AND v."number" = d."version");--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Knowledge base permissions. Zero can't recurse, so the effective access of every folder and
-- document is materialized in acl_entry: own grants + the parent's entries (unless the node is
-- restricted), highest level per principal. Root-level nodes inherit the organization default:
-- every member can edit. Kept up to date by triggers on grants and on the tree.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION "acl_level_rank"(l text) RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE l WHEN 'manage' THEN 3 WHEN 'edit' THEN 2 WHEN 'read' THEN 1 ELSE 0 END
$$;--> statement-breakpoint
-- Recomputes a node and everything under it, parents before children
CREATE FUNCTION "acl_recompute"(p_node text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  queue text[] := ARRAY[p_node];
  cur text;
  n_kind text;
  n_org text;
  n_parent text;
  n_inherit boolean;
BEGIN
  WHILE coalesce(array_length(queue, 1), 0) > 0 LOOP
    cur := queue[1];
    queue := queue[2:];
    n_kind := NULL;
    SELECT 'folder', f."organization_id", f."parent_id", f."inherit_grants" INTO n_kind, n_org, n_parent, n_inherit
      FROM "doc_folder" f WHERE f."id" = cur;
    IF n_kind IS NULL THEN
      SELECT 'doc', d."organization_id", d."folder_id", d."inherit_grants" INTO n_kind, n_org, n_parent, n_inherit
        FROM "doc" d WHERE d."id" = cur;
    END IF;
    DELETE FROM "acl_entry" WHERE "node_id" = cur;
    CONTINUE WHEN n_kind IS NULL;
    INSERT INTO "acl_entry" ("id", "organization_id", "node_id", "node_kind", "principal_type", "principal_id", "level")
    SELECT cur || ':' || e.principal_type || ':' || coalesce(e.principal_id, 'org'), n_org, cur, n_kind,
           e.principal_type, e.principal_id, (ARRAY['read', 'edit', 'manage'])[max("acl_level_rank"(e.level))]
      FROM (
        SELECT g."principal_type" AS principal_type, g."principal_id" AS principal_id, g."level" AS level
          FROM "access_grant" g WHERE g."node_id" = cur
        UNION ALL
        SELECT p."principal_type", p."principal_id", p."level"
          FROM "acl_entry" p WHERE n_inherit AND n_parent IS NOT NULL AND p."node_id" = n_parent
        UNION ALL
        SELECT 'org', NULL, 'edit' WHERE n_inherit AND n_parent IS NULL
      ) e
     GROUP BY e.principal_type, e.principal_id;
    IF n_kind = 'folder' THEN
      queue := queue
        || ARRAY(SELECT f."id" FROM "doc_folder" f WHERE f."parent_id" = cur)
        || ARRAY(SELECT d."id" FROM "doc" d WHERE d."folder_id" = cur);
    END IF;
  END LOOP;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "acl_on_grant"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN PERFORM "acl_recompute"(OLD."node_id"); END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW."node_id" IS DISTINCT FROM OLD."node_id") THEN
    PERFORM "acl_recompute"(NEW."node_id");
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "acl_grant" AFTER INSERT OR UPDATE OR DELETE ON "access_grant"
  FOR EACH ROW EXECUTE FUNCTION "acl_on_grant"();--> statement-breakpoint
CREATE FUNCTION "acl_on_node"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM "acl_entry" WHERE "node_id" = OLD."id";
    RETURN NULL;
  END IF;
  PERFORM "acl_recompute"(NEW."id");
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "acl_folder" AFTER INSERT OR DELETE OR UPDATE OF "parent_id", "inherit_grants" ON "doc_folder"
  FOR EACH ROW EXECUTE FUNCTION "acl_on_node"();--> statement-breakpoint
CREATE TRIGGER "acl_doc" AFTER INSERT OR DELETE OR UPDATE OF "folder_id", "inherit_grants" ON "doc"
  FOR EACH ROW EXECUTE FUNCTION "acl_on_node"();--> statement-breakpoint
-- Access level of a user on a folder or document: 0 none, 1 read, 2 edit, 3 manage (owners/admins: 3)
CREATE FUNCTION "doc_access_level"(p_user text, p_node text) RETURNS int LANGUAGE sql STABLE AS $$
  WITH n AS (
    SELECT d."organization_id" FROM "doc" d WHERE d."id" = p_node
    UNION ALL
    SELECT f."organization_id" FROM "doc_folder" f WHERE f."id" = p_node
    LIMIT 1
  ), m AS (
    SELECT mm."role" FROM "member" mm JOIN n ON mm."organization_id" = n."organization_id" WHERE mm."user_id" = p_user
  )
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM m) THEN 0
    WHEN EXISTS (SELECT 1 FROM m WHERE m."role" IN ('owner', 'admin')) THEN 3
    ELSE coalesce((
      SELECT max("acl_level_rank"(e."level")) FROM "acl_entry" e
       WHERE e."node_id" = p_node
         AND (e."principal_type" = 'org'
           OR (e."principal_type" = 'user' AND e."principal_id" = p_user)
           OR (e."principal_type" = 'team' AND EXISTS (
                 SELECT 1 FROM "team_member" tm WHERE tm."team_id" = e."principal_id" AND tm."user_id" = p_user)))
    ), 0)
  END
$$;--> statement-breakpoint
-- Documents in full-text search (trashed documents leave the index)
CREATE FUNCTION "search_index_doc"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM "search_doc" WHERE "id" = 'doc:' || OLD."id";
    RETURN OLD;
  END IF;
  IF NEW."deleted_at" IS NOT NULL THEN
    DELETE FROM "search_doc" WHERE "id" = 'doc:' || NEW."id";
    RETURN NEW;
  END IF;
  PERFORM "search_upsert"('doc:' || NEW."id", NEW."organization_id", 'doc', NEW."id", NULL, NULL, NULL,
                          coalesce(NEW."updated_by", NEW."created_by"), NEW."created_at", NEW."title", NEW."content");
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "search_doc_index" AFTER INSERT OR DELETE OR UPDATE OF "title", "content", "deleted_at" ON "doc"
  FOR EACH ROW EXECUTE FUNCTION "search_index_doc"();--> statement-breakpoint
-- Backfill: resolve every existing tree from its roots, index existing documents
SELECT "acl_recompute"(f."id") FROM "doc_folder" f WHERE f."parent_id" IS NULL;--> statement-breakpoint
SELECT "acl_recompute"(d."id") FROM "doc" d WHERE d."folder_id" IS NULL;--> statement-breakpoint
SELECT "search_upsert"('doc:' || d."id", d."organization_id", 'doc', d."id", NULL, NULL, NULL, coalesce(d."updated_by", d."created_by"),
                       d."created_at", d."title", d."content")
  FROM "doc" d WHERE d."deleted_at" IS NULL;
