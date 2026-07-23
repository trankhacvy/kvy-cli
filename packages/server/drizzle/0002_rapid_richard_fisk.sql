CREATE TABLE "auth_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"kind" text NOT NULL,
	"identifier" text NOT NULL,
	"password_hash" text,
	"email" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"previous_refresh_token_hash" text,
	"previous_rotated_at" timestamp,
	"family_id" text NOT NULL,
	"client_kind" text NOT NULL,
	"label" text,
	"machine_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_refreshed_at" timestamp,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp,
	CONSTRAINT "device_sessions_refresh_token_hash_unique" UNIQUE("refresh_token_hash")
);
--> statement-breakpoint
CREATE TABLE "key_bind_nonces" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"nonce" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	CONSTRAINT "key_bind_nonces_nonce_unique" UNIQUE("nonce")
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"auth_identity_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	CONSTRAINT "password_reset_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "sign_public_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "content_pub_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "key_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "key_epoch" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "key_epoch" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "key_epoch" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_sessions" ADD CONSTRAINT "device_sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_bind_nonces" ADD CONSTRAINT "key_bind_nonces_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_auth_identity_id_auth_identities_id_fk" FOREIGN KEY ("auth_identity_id") REFERENCES "public"."auth_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identities_kind_identifier_index" ON "auth_identities" USING btree ("kind","identifier");--> statement-breakpoint
CREATE INDEX "auth_identities_account_id_index" ON "auth_identities" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "device_sessions_account_id_index" ON "device_sessions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "device_sessions_family_id_index" ON "device_sessions" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "device_sessions_previous_refresh_token_hash_index" ON "device_sessions" USING btree ("previous_refresh_token_hash");--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "oauth_provider";--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "oauth_subject";