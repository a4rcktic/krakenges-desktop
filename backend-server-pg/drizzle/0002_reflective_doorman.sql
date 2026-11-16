ALTER TABLE "license_keys" ADD COLUMN "custom_plan_name" text;--> statement-breakpoint
ALTER TABLE "license_keys" ADD COLUMN "max_profiles" integer;--> statement-breakpoint
ALTER TABLE "license_keys" ADD COLUMN "max_sessions" integer;--> statement-breakpoint
ALTER TABLE "license_keys" ADD COLUMN "max_api_keys" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "custom_plan_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "max_profiles" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "max_sessions" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "max_api_keys" integer;--> statement-breakpoint
ALTER TABLE "license_keys" ADD CONSTRAINT "license_keys_custom_limits_check" CHECK (("license_keys"."max_profiles" is null or "license_keys"."max_profiles" >= -1)
          and ("license_keys"."max_sessions" is null or "license_keys"."max_sessions" >= -1)
          and ("license_keys"."max_api_keys" is null or "license_keys"."max_api_keys" >= -1));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_custom_limits_check" CHECK (("users"."max_profiles" is null or "users"."max_profiles" >= -1)
          and ("users"."max_sessions" is null or "users"."max_sessions" >= -1)
          and ("users"."max_api_keys" is null or "users"."max_api_keys" >= -1));