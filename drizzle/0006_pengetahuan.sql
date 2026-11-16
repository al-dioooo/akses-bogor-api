-- Basis pengetahuan agen rute (ADR-0042): sumber dengan lisensi dan tanggal ambil, potongan teks untuk full-text search
-- `simple` dan pg_trgm, fitur OpenStreetMap, dan rute bus. Isinya dari skrip `scripts/pengetahuan/`, bukan dari migrasi.
CREATE TYPE "public"."knowledge_kind" AS ENUM('osm', 'angkutan_umum', 'regulasi', 'dokumen_aksesbogor');--> statement-breakpoint
CREATE TYPE "public"."osm_feature_kind" AS ENUM('tangga', 'lift', 'pintu_masuk', 'kerb', 'ramp', 'guiding_block', 'halte', 'tempat');--> statement-breakpoint
CREATE TABLE "knowledge_passages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source_id" varchar(80) NOT NULL,
	"position" integer NOT NULL,
	"citation" varchar(300) NOT NULL,
	"heading" varchar(300),
	"body" text NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce(citation, '') || ' ' || coalesce(heading, '')), 'A') || setweight(to_tsvector('simple', body), 'B')) STORED NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" varchar(80) PRIMARY KEY NOT NULL,
	"kind" "knowledge_kind" NOT NULL,
	"title" varchar(300) NOT NULL,
	"url" text NOT NULL,
	"license" varchar(300) NOT NULL,
	"attribution" varchar(300),
	"retrieved_at" timestamp with time zone NOT NULL,
	"sha256" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "osm_features" (
	"osm_type" varchar(8) NOT NULL,
	"osm_id" bigint NOT NULL,
	"source_id" varchar(80) NOT NULL,
	"kind" "osm_feature_kind" NOT NULL,
	"name" varchar(200),
	"tags" jsonb NOT NULL,
	"geom" geometry(Geometry, 4326) NOT NULL,
	CONSTRAINT "osm_features_osm_type_osm_id_pk" PRIMARY KEY("osm_type","osm_id")
);
--> statement-breakpoint
CREATE TABLE "transit_routes" (
	"osm_id" bigint PRIMARY KEY NOT NULL,
	"source_id" varchar(80) NOT NULL,
	"ref" varchar(40),
	"name" varchar(300),
	"operator" varchar(200),
	"network" varchar(200),
	"from_name" varchar(200),
	"to_name" varchar(200),
	"stops" jsonb NOT NULL,
	"geom" geometry(MultiLineString, 4326)
);
--> statement-breakpoint
ALTER TABLE "knowledge_passages" ADD CONSTRAINT "knowledge_passages_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "osm_features" ADD CONSTRAINT "osm_features_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transit_routes" ADD CONSTRAINT "transit_routes_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_passages_source_position_idx" ON "knowledge_passages" USING btree ("source_id","position");--> statement-breakpoint
CREATE INDEX "knowledge_passages_search_idx" ON "knowledge_passages" USING gin ("search");--> statement-breakpoint
CREATE INDEX "knowledge_passages_body_trgm_idx" ON "knowledge_passages" USING gin ("body" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "osm_features_geom_idx" ON "osm_features" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "osm_features_kind_idx" ON "osm_features" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "osm_features_source_idx" ON "osm_features" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "transit_routes_geom_idx" ON "transit_routes" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "transit_routes_source_idx" ON "transit_routes" USING btree ("source_id");