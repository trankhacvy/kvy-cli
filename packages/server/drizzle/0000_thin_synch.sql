CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"sign_public_key" text NOT NULL,
	"content_pub_key" text NOT NULL,
	"oauth_provider" text,
	"oauth_subject" text,
	"header_seq" integer DEFAULT 0 NOT NULL,
	"settings" "bytea",
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_sign_public_key_unique" UNIQUE("sign_public_key")
);
--> statement-breakpoint
CREATE TABLE "blobs" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"session_id" text,
	"size" integer NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machines" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"metadata" "bytea" NOT NULL,
	"metadata_version" integer DEFAULT 0 NOT NULL,
	"daemon_state" "bytea",
	"daemon_state_version" integer DEFAULT 0 NOT NULL,
	"dek" "bytea" NOT NULL,
	"last_seen_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "pair_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"eph_pub" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"response" "bytea",
	"token" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "pair_requests_eph_pub_unique" UNIQUE("eph_pub")
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"channel" text NOT NULL,
	"endpoint" text NOT NULL,
	"keys" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "session_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"local_id" text,
	"content" "bytea" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"workspace_id" text,
	"machine_id" text,
	"tag" text NOT NULL,
	"provider" text NOT NULL,
	"execution_target" text DEFAULT 'local' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"metadata" "bytea" NOT NULL,
	"metadata_version" integer DEFAULT 0 NOT NULL,
	"agent_state" "bytea",
	"agent_state_version" integer DEFAULT 0 NOT NULL,
	"dek" "bytea" NOT NULL,
	"msg_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unmanaged_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"provider_ref" text NOT NULL,
	"summary" "bytea" NOT NULL,
	"dek" "bytea" NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"metadata" "bytea" NOT NULL,
	"metadata_version" integer DEFAULT 0 NOT NULL,
	"dek" "bytea" NOT NULL,
	"sync_enabled" boolean DEFAULT false NOT NULL,
	"sandbox_config" "bytea"
);
--> statement-breakpoint
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_messages" ADD CONSTRAINT "session_messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blobs_account_id_index" ON "blobs" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "machines_account_id_index" ON "machines" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "push_subscriptions_account_id_index" ON "push_subscriptions" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_messages_session_id_seq_index" ON "session_messages" USING btree ("session_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "session_messages_session_id_local_id_index" ON "session_messages" USING btree ("session_id","local_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_account_id_tag_index" ON "sessions" USING btree ("account_id","tag");--> statement-breakpoint
CREATE INDEX "sessions_account_id_updated_at_index" ON "sessions" USING btree ("account_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "unmanaged_sessions_machine_id_provider_ref_index" ON "unmanaged_sessions" USING btree ("machine_id","provider_ref");