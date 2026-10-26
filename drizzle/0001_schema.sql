-- Disunting dari hasil drizzle-kit: kolom titik diberi SRID 4326, karena drizzle-kit 0.31 tidak menuliskannya.
CREATE TYPE "public"."facility_answer" AS ENUM('tersedia', 'tidak_tersedia', 'tidak_perlu', 'belum_tahu');--> statement-breakpoint
CREATE TYPE "public"."facility_kind" AS ENUM('ramp', 'toilet_difabel', 'guiding_block', 'lift');--> statement-breakpoint
CREATE TYPE "public"."photo_moderation" AS ENUM('menunggu', 'tayang', 'disembunyikan');--> statement-breakpoint
CREATE TYPE "public"."photo_tag" AS ENUM('pintu_masuk', 'toilet_difabel', 'guiding_block', 'lift', 'lainnya');--> statement-breakpoint
CREATE TYPE "public"."place_category" AS ENUM('kampus', 'masjid', 'halte', 'rumah_sakit');--> statement-breakpoint
CREATE TYPE "public"."place_status" AS ENUM('aksesibel', 'sebagian', 'tidak_aksesibel', 'belum_diketahui');--> statement-breakpoint
CREATE TYPE "public"."rejection_reason" AS ENUM('di_luar_kota_bogor', 'duplikat', 'bukti_tidak_cukup', 'bukan_fasilitas_publik', 'konten_tidak_pantas', 'tidak_ada_klarifikasi');--> statement-breakpoint
CREATE TYPE "public"."report_kind" AS ENUM('baru', 'perubahan', 'kekurangan');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('menunggu', 'klarifikasi', 'diterbitkan', 'ditolak');--> statement-breakpoint
CREATE TYPE "public"."unavailable_reason" AS ENUM('tidak_ada', 'rusak', 'terhalang', 'terbatas', 'tidak_sesuai');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('pengguna', 'verifikator', 'admin');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"entity_type" varchar(20) NOT NULL,
	"entity_id" uuid NOT NULL,
	"actor_id" uuid,
	"actor_label" varchar(40),
	"action" varchar(40) NOT NULL,
	"changes" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "districts" (
	"slug" varchar(40) PRIMARY KEY NOT NULL,
	"name" varchar(60) NOT NULL,
	"city" varchar(60) DEFAULT 'Kota Bogor' NOT NULL,
	"boundary" geometry(MultiPolygon, 4326),
	CONSTRAINT "districts_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"place_id" uuid,
	"storage_key" varchar(200) NOT NULL,
	"tag" "photo_tag" DEFAULT 'lainnya' NOT NULL,
	"alt_text" varchar(200) NOT NULL,
	"caption" varchar(200),
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bytes" integer NOT NULL,
	"moderation" "photo_moderation" DEFAULT 'menunggu' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "photos_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "place_facilities" (
	"place_id" uuid NOT NULL,
	"facility" "facility_kind" NOT NULL,
	"answer" "facility_answer" NOT NULL,
	"reason" "unavailable_reason",
	"note" varchar(200),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "place_facilities_place_id_facility_pk" PRIMARY KEY("place_id","facility"),
	CONSTRAINT "place_facilities_reason_only_when_unavailable" CHECK ("place_facilities"."reason" IS NULL OR "place_facilities"."answer" = 'tidak_tersedia')
);
--> statement-breakpoint
CREATE TABLE "places" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"category" "place_category" NOT NULL,
	"district_slug" varchar(40) NOT NULL,
	"location" geometry(Point, 4326) NOT NULL,
	"landmark" varchar(140),
	"description" text,
	"status" "place_status" NOT NULL,
	"facilities_available" smallint NOT NULL,
	"facilities_relevant" smallint NOT NULL,
	"facilities_unknown" smallint NOT NULL,
	"last_verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_id" uuid,
	"kind" "report_kind" NOT NULL,
	"place_id" uuid,
	"status" "report_status" DEFAULT 'menunggu' NOT NULL,
	"submission" jsonb NOT NULL,
	"location" geometry(Point, 4326),
	"rejection_reason" "rejection_reason",
	"clarification_question" text,
	"clarification_due_at" timestamp with time zone,
	"reviewer_id" uuid,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "reports_rejection_reason_matches_status" CHECK (("reports"."status" = 'ditolak') = ("reports"."rejection_reason" IS NOT NULL)),
	CONSTRAINT "reports_existing_place_for_changes" CHECK ("reports"."kind" = 'baru' OR "reports"."place_id" IS NOT NULL OR "reports"."status" = 'ditolak')
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" varchar(60) NOT NULL,
	"email" varchar(254) NOT NULL,
	"role" "user_role" DEFAULT 'pengguna' NOT NULL,
	"privacy_consent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_facilities" ADD CONSTRAINT "place_facilities_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_district_slug_districts_slug_fk" FOREIGN KEY ("district_slug") REFERENCES "public"."districts"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "photos_place_idx" ON "photos" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "photos_report_idx" ON "photos" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "places_location_idx" ON "places" USING gist ("location");--> statement-breakpoint
CREATE INDEX "places_name_trgm_idx" ON "places" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "places_category_idx" ON "places" USING btree ("category");--> statement-breakpoint
CREATE INDEX "places_status_idx" ON "places" USING btree ("status");--> statement-breakpoint
CREATE INDEX "places_district_idx" ON "places" USING btree ("district_slug");--> statement-breakpoint
CREATE INDEX "reports_queue_idx" ON "reports" USING btree ("status","submitted_at");--> statement-breakpoint
CREATE INDEX "reports_reporter_idx" ON "reports" USING btree ("reporter_id");--> statement-breakpoint
CREATE INDEX "reports_place_idx" ON "reports" USING btree ("place_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree (lower("email"));