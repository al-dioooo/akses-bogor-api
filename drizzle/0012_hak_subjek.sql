-- Permintaan hak subjek data (Kebijakan Privasi bagian "Hak Anda", UU No. 27/2022): catatan permintaan, laporan yang
-- ditahan atas permintaan pelapor, dan email status laporan yang dimatikan. Hanya menambah tabel dan kolom nullable, jadi
-- baris lama tetap sah dan versi API sebelumnya tetap berjalan.
CREATE TYPE "public"."data_subject_request_kind" AS ENUM('salinan', 'perbaikan', 'pembatasan', 'penghapusan', 'keberatan', 'pertanyaan');--> statement-breakpoint
CREATE TYPE "public"."data_subject_request_outcome" AS ENUM('selesai', 'ditolak');--> statement-breakpoint
CREATE TABLE "data_subject_requests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" "data_subject_request_kind" NOT NULL,
	"user_id" uuid,
	"received_at" timestamp with time zone NOT NULL,
	"handled_by" uuid,
	"completed_at" timestamp with time zone,
	"outcome" "data_subject_request_outcome",
	"note" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_subject_requests_outcome_with_time" CHECK (("data_subject_requests"."completed_at" IS NULL) = ("data_subject_requests"."outcome" IS NULL)),
	CONSTRAINT "data_subject_requests_refusal_reason" CHECK ("data_subject_requests"."outcome" IS DISTINCT FROM 'ditolak' OR "data_subject_requests"."note" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "held_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "hold_reason" varchar(500);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "report_emails_off_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_handled_by_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_subject_requests_user_idx" ON "data_subject_requests" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_hold_with_reason" CHECK (("reports"."held_at" IS NULL) = ("reports"."hold_reason" IS NULL));