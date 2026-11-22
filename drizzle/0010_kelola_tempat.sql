-- Tempat yang dibuat, diubah, atau diterbitkan langsung oleh admin, dan tempat yang diturunkan dengan alasannya (ADR-0050).
-- Semua kolom boleh kosong, jadi baris lama tetap sah: lewat verifikasi dan tayang.
ALTER TABLE "places" ADD COLUMN "admin_published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "admin_published_by" uuid;--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "unpublished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "unpublished_reason" varchar(500);--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_admin_published_by_users_id_fk" FOREIGN KEY ("admin_published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_unpublished_with_reason" CHECK (("places"."unpublished_at" IS NULL) = ("places"."unpublished_reason" IS NULL));