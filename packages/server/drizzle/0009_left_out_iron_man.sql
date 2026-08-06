DROP INDEX IF EXISTS "workspaces_account_id_path_index";--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "path_hash" text;--> statement-breakpoint
UPDATE "workspaces" SET "path_hash" = md5("path") WHERE "path_hash" IS NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ALTER COLUMN "path_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "path";--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_account_id_path_hash_index" ON "workspaces" USING btree ("account_id","path_hash");--> statement-breakpoint
-- Pre-existing `sessions.workspace_id` values (if any) hold raw filesystem
-- paths from before this migration, which never match a real `workspaces.id`
-- — clear them rather than violate the new FK; a session simply loses its
-- workspace association, the same graceful-degradation state a failed
-- workspace resolution already produces client-side.
UPDATE "sessions" SET "workspace_id" = NULL WHERE "workspace_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
