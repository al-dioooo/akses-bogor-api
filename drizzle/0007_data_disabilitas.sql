CREATE TYPE "public"."disability_category" AS ENUM('fisik', 'netra', 'mental', 'lainnya');--> statement-breakpoint
ALTER TYPE "public"."knowledge_kind" ADD VALUE 'data_disabilitas';--> statement-breakpoint
CREATE TABLE "disability_counts" (
	"source_id" varchar(80) NOT NULL,
	"district_slug" varchar(40) NOT NULL,
	"year" smallint NOT NULL,
	"category" "disability_category" NOT NULL,
	"source_label" varchar(60) NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "disability_counts_source_id_district_slug_year_category_pk" PRIMARY KEY("source_id","district_slug","year","category"),
	CONSTRAINT "disability_counts_count_check" CHECK ("disability_counts"."count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "disability_counts" ADD CONSTRAINT "disability_counts_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disability_counts" ADD CONSTRAINT "disability_counts_district_slug_districts_slug_fk" FOREIGN KEY ("district_slug") REFERENCES "public"."districts"("slug") ON DELETE no action ON UPDATE no action;