-- Kolom bentuk dasar untuk retrieval basis pengetahuan (ADR-0044). Isinya dihitung API dengan stemmer bahasa Indonesia,
-- bukan oleh PostgreSQL; baris lama berisi kosong sampai `pnpm pengetahuan:indeks` dijalankan.
ALTER TABLE "knowledge_passages" ADD COLUMN "search_stem" "tsvector" DEFAULT ''::tsvector NOT NULL;--> statement-breakpoint
CREATE INDEX "knowledge_passages_search_stem_idx" ON "knowledge_passages" USING gin ("search_stem");