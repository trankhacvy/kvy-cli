ALTER TABLE "auth_identities" ADD COLUMN "failed_login_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD COLUMN "locked_until" timestamp;