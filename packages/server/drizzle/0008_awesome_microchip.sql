ALTER TABLE "workspaces" ADD COLUMN "path" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_account_id_path_index" ON "workspaces" USING btree ("account_id","path");--> statement-breakpoint
CREATE INDEX "workspaces_account_id_index" ON "workspaces" USING btree ("account_id");