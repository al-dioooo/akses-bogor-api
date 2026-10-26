-- PostGIS untuk koordinat dan batas kecamatan (ADR-0010, ADR-0015); pg_trgm untuk pencarian sebagian kata (FR-02).
CREATE EXTENSION IF NOT EXISTS postgis;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
