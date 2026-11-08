-- Verifikasi (ADR-0036 sampai ADR-0039): klarifikasi laporan, catatan verifikator, area kabur foto, dan antrean email status.
CREATE TYPE "public"."report_email_kind" AS ENUM('diterbitkan', 'ditolak', 'klarifikasi');--> statement-breakpoint
CREATE TABLE "report_clarifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"question" varchar(1000) NOT NULL,
	"asked_by" uuid,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"answer" varchar(1000),
	"answered_at" timestamp with time zone,
	CONSTRAINT "report_clarifications_answer_with_time" CHECK (("report_clarifications"."answer" IS NULL) = ("report_clarifications"."answered_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "report_emails" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"report_id" uuid NOT NULL,
	"kind" "report_email_kind" NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "blur_regions" jsonb;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "clarification_id" uuid;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "reviewer_note" varchar(1000);--> statement-breakpoint
ALTER TABLE "report_clarifications" ADD CONSTRAINT "report_clarifications_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_clarifications" ADD CONSTRAINT "report_clarifications_asked_by_users_id_fk" FOREIGN KEY ("asked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_emails" ADD CONSTRAINT "report_emails_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_clarifications_report_idx" ON "report_clarifications" USING btree ("report_id","asked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "report_emails_report_kind_idx" ON "report_emails" USING btree ("report_id","kind");--> statement-breakpoint
CREATE INDEX "report_emails_next_idx" ON "report_emails" USING btree ("next_attempt_at");--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_clarification_id_report_clarifications_id_fk" FOREIGN KEY ("clarification_id") REFERENCES "public"."report_clarifications"("id") ON DELETE set null ON UPDATE no action;