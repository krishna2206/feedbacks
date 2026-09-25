CREATE TABLE "api_idempotency" (
	"token_id" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" integer,
	"response" json,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_idempotency_token_id_key_pk" PRIMARY KEY("token_id","key")
);
--> statement-breakpoint
CREATE TABLE "api_token" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"scope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text
);
--> statement-breakpoint
ALTER TABLE "comment" ADD COLUMN "via" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "via" text;--> statement-breakpoint
ALTER TABLE "api_idempotency" ADD CONSTRAINT "api_idempotency_token_id_api_token_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."api_token"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_idempotency_created_idx" ON "api_idempotency" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "api_token_hash_uq" ON "api_token" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "api_token_org_user_idx" ON "api_token" USING btree ("organization_id","user_id","created_at");