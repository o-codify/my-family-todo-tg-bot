CREATE TABLE IF NOT EXISTS "google_oauth_tokens" (
  "user_id"           uuid PRIMARY KEY,
  "access_token_enc"  text NOT NULL,
  "refresh_token_enc" text NOT NULL,
  "expires_at"        timestamp with time zone NOT NULL,
  "calendar_id"       text NOT NULL,
  "scope"             text NOT NULL,
  "connected_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"        timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

ALTER TABLE "google_oauth_tokens"
  ADD CONSTRAINT "google_oauth_tokens_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade;
