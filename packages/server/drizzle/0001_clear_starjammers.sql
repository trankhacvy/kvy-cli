CREATE TABLE "telegram_link_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"account_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "telegram_link_requests_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "notifications_muted_all" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "notifications_muted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_link_requests" ADD CONSTRAINT "telegram_link_requests_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;