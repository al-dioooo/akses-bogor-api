// Indikator prioritas kecamatan untuk kontributor (ADR-0043). Rumusnya sengaja sederhana supaya bisa dijelaskan:
//
//   kebutuhan   = D / D_maks                (D: penyandang disabilitas terdaftar di Dinsos pada tahun terbaru)
//   kekurangan  = G / (G + V), atau 1 bila G + V = 0
//                                           (G: tempat OSM empat kategori tanpa data AksesBogor, V: lokasi AksesBogor)
//   skor        = bulatkan(100 × kebutuhan × kekurangan)
//
// Tingkat: sangat tinggi ≥ 75, tinggi ≥ 50, sedang ≥ 25, rendah < 25. Peringkat menurut skor, lalu D, lalu nama.
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { DISABILITY_CAVEAT, DISABILITY_SOURCE } from "./disability.js";
import { FACILITIES_SOURCE_ID, withoutAksesBogorData } from "./facilities.js";

export type PriorityLevel = "rendah" | "sedang" | "tinggi" | "sangat_tinggi";
export type DistrictPriority = {
  slug: string;
  name: string;
  /** Penyandang disabilitas terdaftar di Dinsos pada `year`; bukan jumlah seluruh penduduk. */
  registered: number;
  verifiedPlaces: number;
  facilitiesWithoutData: number;
  score: number;
  rank: number;
  level: PriorityLevel;
};
export type KecamatanPriority = {
  year: number;
  yearTotals: { year: number; registered: number }[];
  districts: DistrictPriority[];
  caveat: string;
  formula: string;
  source: { title: string; url: string; publisher: string; retrievedAt: string; terms: string };
  facilitiesSource: { retrievedAt: string | null; attribution: string };
};

export const PRIORITY_FORMULA =
  "skor = 100 × (terdaftar ÷ terdaftar terbanyak) × (tempat tanpa data ÷ (tempat tanpa data + lokasi AksesBogor)); sangat tinggi ≥ 75, tinggi ≥ 50, sedang ≥ 25.";

export function levelOf(score: number): PriorityLevel {
  if (score >= 75) return "sangat_tinggi";
  if (score >= 50) return "tinggi";
  if (score >= 25) return "sedang";
  return "rendah";
}

type Counts = { slug: string; name: string; registered: number; verifiedPlaces: number; facilitiesWithoutData: number };

/** Skor, peringkat, dan tingkat dari hitungan per kecamatan. Fungsi murni, dites terpisah. */
export function rankDistricts(counts: readonly Counts[]): DistrictPriority[] {
  const maxRegistered = Math.max(0, ...counts.map((c) => c.registered));
  const scored = counts.map((c) => {
    const need = maxRegistered > 0 ? c.registered / maxRegistered : 0;
    const known = c.facilitiesWithoutData + c.verifiedPlaces;
    const gap = known > 0 ? c.facilitiesWithoutData / known : 1;
    const score = Math.round(100 * need * gap);
    return { ...c, score, level: levelOf(score) };
  });
  scored.sort((a, b) => b.score - a.score || b.registered - a.registered || a.name.localeCompare(b.name, "id"));
  return scored.map((c, i) => ({ ...c, rank: i + 1 }));
}

const rowsOf = <T>(result: unknown) => (result as { rows: T[] }).rows;

/** Prioritas kecamatan dari data di database, atau null bila data disabilitas belum dimuat. */
export async function kecamatanPriority(db: Db): Promise<KecamatanPriority | null> {
  const totals = rowsOf<{ year: number; registered: number }>(
    await db.execute(sql`SELECT year, sum(count)::int AS registered FROM disability_counts WHERE source_id = ${DISABILITY_SOURCE.id} GROUP BY year ORDER BY year`),
  );
  const year = totals.at(-1)?.year;
  if (year === undefined) return null;
  const counts = rowsOf<Counts>(
    await db.execute(sql`
      SELECT d.slug, d.name,
        coalesce((SELECT sum(c.count) FROM disability_counts c WHERE c.district_slug = d.slug AND c.year = ${year} AND c.source_id = ${DISABILITY_SOURCE.id}), 0)::int AS "registered",
        (SELECT count(*) FROM places p WHERE p.district_slug = d.slug)::int AS "verifiedPlaces",
        (SELECT count(*) FROM osm_places o WHERE o.district_slug = d.slug AND ${withoutAksesBogorData})::int AS "facilitiesWithoutData"
      FROM districts d ORDER BY d.slug`),
  );
  const sources = rowsOf<{ id: string; retrieved_at: Date | string; attribution: string | null }>(
    await db.execute(sql`SELECT id, retrieved_at, attribution FROM knowledge_sources WHERE id IN (${DISABILITY_SOURCE.id}, ${FACILITIES_SOURCE_ID})`),
  );
  const retrieved = (id: string) => {
    const value = sources.find((s) => s.id === id)?.retrieved_at;
    return value ? new Date(value).toISOString() : null;
  };
  return {
    year,
    yearTotals: totals.map((t) => ({ year: Number(t.year), registered: Number(t.registered) })),
    districts: rankDistricts(counts),
    caveat: DISABILITY_CAVEAT,
    formula: PRIORITY_FORMULA,
    source: { title: DISABILITY_SOURCE.title, url: DISABILITY_SOURCE.url, publisher: DISABILITY_SOURCE.publisher, retrievedAt: retrieved(DISABILITY_SOURCE.id)!, terms: DISABILITY_SOURCE.terms },
    facilitiesSource: { retrievedAt: retrieved(FACILITIES_SOURCE_ID), attribution: "© kontributor OpenStreetMap" },
  };
}

/** Batas kecamatan ADR-0034 sebagai GeoJSON yang disederhanakan, untuk lapisan peta di web. */
export async function districtBoundaries(db: Db) {
  const rows = rowsOf<{ slug: string; name: string; geometry: string }>(
    await db.execute(
      sql`SELECT slug, name, ST_AsGeoJSON(ST_SimplifyPreserveTopology(boundary, 0.0001), 5) AS geometry FROM districts WHERE boundary IS NOT NULL ORDER BY slug`,
    ),
  );
  return {
    type: "FeatureCollection" as const,
    attribution: "© kontributor OpenStreetMap",
    features: rows.map((r) => ({ type: "Feature" as const, properties: { slug: r.slug, name: r.name }, geometry: JSON.parse(r.geometry) as { type: string; coordinates: unknown } })),
  };
}
