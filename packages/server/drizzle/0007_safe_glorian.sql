CREATE TABLE "key_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"eph_pub" text NOT NULL,
	"requested_by_session_id" text NOT NULL,
	"label" text,
	"response" "bytea",
	"approved_by_session_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "key_requests" ADD CONSTRAINT "key_requests_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "key_requests_account_id_eph_pub_index" ON "key_requests" USING btree ("account_id","eph_pub");--> statement-breakpoint
CREATE INDEX "key_requests_account_id_index" ON "key_requests" USING btree ("account_id");