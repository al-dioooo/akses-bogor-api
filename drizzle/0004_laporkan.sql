ALTER TABLE "photos" ALTER COLUMN "report_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "uploader_id" uuid;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "district_slug" varchar(40);--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "submission_key" uuid;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_district_slug_districts_slug_fk" FOREIGN KEY ("district_slug") REFERENCES "public"."districts"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "districts_boundary_idx" ON "districts" USING gist ("boundary");--> statement-breakpoint
CREATE INDEX "photos_uploader_idx" ON "photos" USING btree ("uploader_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_submission_key_idx" ON "reports" USING btree ("reporter_id","submission_key");--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_report_or_uploader" CHECK (("photos"."report_id" IS NULL) = ("photos"."uploader_id" IS NOT NULL));--> statement-breakpoint
