-- Pre-existing rows (if any) hold raw filesystem paths from before this
-- migration, which never match a real `workspaces.id` — drop them rather
-- than violate the new FK. Harmless: the daemon's transcript indexer
-- re-upserts this table on its own poll cycle, keyed by (machineId,
-- providerRef), so a dropped row simply reappears on the next tick.
DELETE FROM "unmanaged_sessions" WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces");--> statement-breakpoint
ALTER TABLE "unmanaged_sessions" ADD CONSTRAINT "unmanaged_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;