CREATE TABLE "osm_places" (
	"osm_type" varchar(8) NOT NULL,
	"osm_id" bigint NOT NULL,
	"source_id" varchar(80) NOT NULL,
	"category" "place_category" NOT NULL,
	"name" varchar(200),
	"district_slug" varchar(40) NOT NULL,
	"tags" jsonb NOT NULL,
	"location" geometry(point) NOT NULL,
	CONSTRAINT "osm_places_osm_type_osm_id_pk" PRIMARY KEY("osm_type","osm_id")
);
--> statement-breakpoint
ALTER TABLE "osm_places" ADD CONSTRAINT "osm_places_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "osm_places" ADD CONSTRAINT "osm_places_district_slug_districts_slug_fk" FOREIGN KEY ("district_slug") REFERENCES "public"."districts"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "osm_places_location_idx" ON "osm_places" USING gist ("location");--> statement-breakpoint
CREATE INDEX "osm_places_district_category_idx" ON "osm_places" USING btree ("district_slug","category");