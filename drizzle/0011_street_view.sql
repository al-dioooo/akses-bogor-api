-- Sumber verifikasi tempat dan foto (ADR-0057): laporan warga, atau bukti Street View dengan bulan gambarnya. Baris lama
-- bernilai `laporan`, jadi tetap sah. Foto Street View dipasang langsung ke tempat, tanpa laporan dan tanpa pengunggah.
CREATE TYPE "public"."verification_source" AS ENUM('laporan', 'street_view');--> statement-breakpoint
ALTER TABLE "photos" DROP CONSTRAINT "photos_report_or_uploader";--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "source" "verification_source" DEFAULT 'laporan' NOT NULL;--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "verification_source" "verification_source" DEFAULT 'laporan' NOT NULL;--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "street_view_image_date" date;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_report_or_uploader" CHECK (("photos"."report_id" IS NULL) = ("photos"."uploader_id" IS NOT NULL) OR ("photos"."source" = 'street_view' AND "photos"."report_id" IS NULL AND "photos"."uploader_id" IS NULL));--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_street_view_image_date" CHECK (("places"."verification_source" = 'street_view') = ("places"."street_view_image_date" IS NOT NULL) AND ("places"."street_view_image_date" IS NULL OR extract(day from "places"."street_view_image_date") = 1));