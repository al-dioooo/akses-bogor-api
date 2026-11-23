// Tempat umum dari OpenStreetMap dalam empat kategori MVP (ADR-0004) sebagai calon tujuan kontributor (ADR-0043):
// kueri Overpass, pengubah hasilnya, penyimpanan, pencarian tempat yang belum punya data AksesBogor, dan kandidat
// lapisan "Belum ada data" di Peta (ADR-0049).
// Data © kontributor OpenStreetMap, berlisensi ODbL.
import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { placeCategory } from "../db/schema.js";
import { KOTA_BOGOR_RELATION, OSM_ATTRIBUTION, OSM_LICENSE, type OverpassElement } from "../knowledge/osm.js";
import { inBatches, replaceSource } from "../knowledge/store.js";

export type PlaceCategory = (typeof placeCategory.enumValues)[number];
export const FACILITIES_SOURCE_ID = "osm-tempat-umum-kota-bogor";
/** Lokasi AksesBogor berkategori sama dalam jarak ini dianggap tempat yang sama, jadi tempat OSM itu sudah punya data. */
export const SAME_PLACE_METERS = 50;

/** Satu kueri area untuk keempat kategori. Tanpa `meta`, jadi tidak ada data penyunting. */
export const FACILITIES_QUERY = `[out:json][timeout:120];
area(id:${3_600_000_000 + KOTA_BOGOR_RELATION})->.kota;
(
  nwr(area.kota)["amenity"~"^(university|college)$"];
  nwr(area.kota)["amenity"="place_of_worship"]["religion"="muslim"];
  node(area.kota)["highway"="bus_stop"];
  nwr(area.kota)["public_transport"="platform"]["bus"="yes"];
  nwr(area.kota)["amenity"="hospital"];
);
out tags center;`;

const KEPT_TAGS = new Set(["name", "amenity", "religion", "highway", "public_transport", "bus", "building", "healthcare", "wheelchair", "toilets:wheelchair"]);

export type FacilityRow = { osmType: OverpassElement["type"]; osmId: number; category: PlaceCategory; name: string | null; tags: Record<string, string>; lat: number; lng: number };

/** Kategori AksesBogor dari tag OSM, atau null bila bukan salah satu dari empat kategori. */
export function categoryOf(tags: Record<string, string>): PlaceCategory | null {
  if (tags.amenity === "university" || tags.amenity === "college") return "kampus";
  if (tags.amenity === "place_of_worship" && tags.religion === "muslim") return "masjid";
  if (tags.amenity === "hospital") return "rumah_sakit";
  if (tags.highway === "bus_stop" || (tags.public_transport === "platform" && tags.bus === "yes")) return "halte";
  return null;
}

/** Hasil Overpass menjadi baris tabel: titik dari node atau titik tengah way/relasi, dan hanya tag dalam daftar izin. */
export function parseFacilities(body: { elements?: OverpassElement[] }): FacilityRow[] {
  const rows: FacilityRow[] = [];
  for (const element of body.elements ?? []) {
    const tags = element.tags ?? {};
    const category = categoryOf(tags);
    const point = element.type === "node" ? (element.lat !== undefined && element.lon !== undefined ? { lat: element.lat, lon: element.lon } : null) : (element.center ?? null);
    if (!category || !point) continue;
    const kept = Object.fromEntries(Object.entries(tags).filter(([key]) => KEPT_TAGS.has(key)));
    rows.push({ osmType: element.type, osmId: element.id, category, name: tags.name?.trim() || null, tags: kept, lat: point.lat, lng: point.lon });
  }
  return rows;
}

const rowsOf = <T>(result: unknown) => (result as { rows: T[] }).rows;

/**
 * Mengganti tempat OSM dari satu unduhan Overpass. Kecamatan dihitung dari batas ADR-0034; tempat di luar keenam
 * kecamatan dibuang. Mengembalikan jumlah tempat yang tersimpan.
 */
export async function loadFacilities(db: Db, rows: readonly FacilityRow[], download: { url: string; retrievedAt: Date; sha256: string }) {
  const source = {
    id: FACILITIES_SOURCE_ID,
    kind: "osm" as const,
    title: "Kampus, masjid, halte, dan rumah sakit di Kota Bogor (OpenStreetMap)",
    url: download.url,
    license: OSM_LICENSE,
    attribution: OSM_ATTRIBUTION,
    retrievedAt: download.retrievedAt,
    sha256: download.sha256,
  };
  await replaceSource(db, source, async (tx) => {
    await inBatches(rows, 500, (batch) => {
      const json = JSON.stringify(batch.map((r) => ({ osm_type: r.osmType, osm_id: r.osmId, category: r.category, name: r.name, tags: r.tags, lat: r.lat, lng: r.lng })));
      return tx.execute(sql`
        INSERT INTO osm_places (osm_type, osm_id, source_id, category, name, district_slug, tags, location)
        SELECT r.osm_type, r.osm_id, ${FACILITIES_SOURCE_ID}, r.category::place_category, r.name, d.slug, r.tags, ST_SetSRID(ST_MakePoint(r.lng, r.lat), 4326)
        FROM jsonb_to_recordset(${json}::jsonb) AS r(osm_type text, osm_id bigint, category text, name text, tags jsonb, lat float8, lng float8)
        JOIN LATERAL (SELECT slug FROM districts WHERE ST_Covers(boundary, ST_SetSRID(ST_MakePoint(r.lng, r.lat), 4326)) LIMIT 1) d ON true`);
    });
  });
  const [{ n } = { n: 0 }] = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM osm_places WHERE source_id = ${FACILITIES_SOURCE_ID}`));
  return n;
}

export type OsmTarget = { osmType: string; osmId: number };
export type ContributionPlace = { osm: OsmTarget; name: string | null; category: PlaceCategory; district: { slug: string; name: string } };
type CandidateRow = { osm_type: string; osm_id: number | string; name: string | null; category: PlaceCategory; slug: string; district: string };

/** Syarat SQL: tidak ada lokasi AksesBogor berkategori sama dalam `SAME_PLACE_METERS` dari tempat OSM `o`. */
// Lokasi yang diturunkan admin tidak dihitung, jadi kandidat OSM di dekatnya tampil lagi (ADR-0050).
export const withoutAksesBogorData = sql`NOT EXISTS (SELECT 1 FROM places p WHERE p.unpublished_at IS NULL AND p.category = o.category AND ST_DWithin(p.location::geography, o.location::geography, ${SAME_PLACE_METERS}))`;

/**
 * Tempat OSM yang belum punya data AksesBogor, bisa dibatasi kecamatan dan kategori. Urutannya mengikuti `districtOrder`
 * (mis. urutan prioritas kecamatan), lalu tempat bernama dulu, lalu nama. Tanpa koordinat: hasil ini untuk model.
 */
export async function placesWithoutData(db: Db, options: { district?: string; category?: PlaceCategory; limit: number; districtOrder?: readonly string[] }): Promise<ContributionPlace[]> {
  const order = JSON.stringify(options.districtOrder ?? []);
  const rows = rowsOf<CandidateRow>(
    await db.execute(sql`
      SELECT o.osm_type, o.osm_id, o.name, o.category, d.slug, d.name AS district
      FROM osm_places o JOIN districts d ON d.slug = o.district_slug
      WHERE ${withoutAksesBogorData}
        ${options.district ? sql`AND o.district_slug = ${options.district}` : sql``}
        ${options.category ? sql`AND o.category = ${options.category}` : sql``}
      ORDER BY coalesce((SELECT ord FROM jsonb_array_elements_text(${order}::jsonb) WITH ORDINALITY AS a(slug, ord) WHERE a.slug = d.slug), 99), o.name IS NULL, o.name, o.osm_id
      LIMIT ${options.limit}`),
  );
  return rows.map((r) => ({ osm: { osmType: r.osm_type, osmId: Number(r.osm_id) }, name: r.name, category: r.category, district: { slug: r.slug, name: r.district } }));
}

/** Satu tempat OSM beserta lokasinya, untuk kartu tempat dan rute di web; null bila tidak ada. */
export async function getOsmPlace(db: Db, target: OsmTarget) {
  const [row] = rowsOf<CandidateRow & { lat: number; lng: number; has_data: boolean }>(
    await db.execute(sql`
      SELECT o.osm_type, o.osm_id, o.name, o.category, d.slug, d.name AS district, ST_Y(o.location) AS lat, ST_X(o.location) AS lng, NOT (${withoutAksesBogorData}) AS has_data
      FROM osm_places o JOIN districts d ON d.slug = o.district_slug
      WHERE o.osm_type = ${target.osmType} AND o.osm_id = ${target.osmId}`),
  );
  if (!row) return null;
  return {
    osm: { osmType: row.osm_type, osmId: Number(row.osm_id) },
    name: row.name,
    category: row.category,
    district: { slug: row.slug, name: row.district },
    location: { lat: Number(row.lat), lng: Number(row.lng) },
    hasAksesBogorData: row.has_data,
    osmUrl: `https://www.openstreetmap.org/${row.osm_type}/${row.osm_id}`,
    attribution: OSM_ATTRIBUTION,
  };
}

/** Kecamatan urut dari tempat tanpa data AksesBogor terbanyak; urutan cadangan bila prioritas kecamatan mati. */
export async function districtsByMissingData(db: Db): Promise<{ slug: string; count: number }[]> {
  return rowsOf<{ slug: string; count: number }>(
    await db.execute(sql`
      SELECT d.slug, count(o.osm_id)::int AS count FROM districts d
      LEFT JOIN osm_places o ON o.district_slug = d.slug AND ${withoutAksesBogorData}
      GROUP BY d.slug ORDER BY count DESC, d.slug`),
  );
}


/** Batas kandidat dalam satu jawaban. Kota Bogor punya sekitar 650 tempat OSM empat kategori. */
export const CANDIDATE_LIMIT = 3000;
const OSM_COPYRIGHT = "https://www.openstreetmap.org/copyright";

export type CandidateFilters = { q?: string; category?: PlaceCategory[]; district?: string[] };
export type Candidate = {
  osm: OsmTarget;
  name: string | null;
  category: PlaceCategory;
  district: { slug: string; name: string };
  location: { lat: number; lng: number };
  /** Nilai mentah tag `wheelchair` OSM, belum diperiksa tim; null bila tidak ada. */
  wheelchair: string | null;
};

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);
const anyOf = (column: SQL, values?: readonly string[]) => (values?.length ? sql`AND ${column} IN (${sql.join(values.map((v) => sql`${v}`), sql`, `)})` : sql``);

/**
 * Kandidat lapisan "Belum ada data" di Peta (ADR-0049): tempat OSM tanpa lokasi AksesBogor berkategori sama dalam
 * `SAME_PLACE_METERS`, dengan titiknya. Kandidat tidak punya status dan tidak pernah dihitung sebagai lokasi terbit.
 * Sumbernya ikut, supaya atribusi ODbL selalu bersama datanya.
 */
export async function listCandidates(db: Db, filters: CandidateFilters) {
  const rows = rowsOf<CandidateRow & { lat: number; lng: number; wheelchair: string | null }>(
    await db.execute(sql`
      SELECT o.osm_type, o.osm_id, o.name, o.category, d.slug, d.name AS district, ST_Y(o.location) AS lat, ST_X(o.location) AS lng, o.tags->>'wheelchair' AS wheelchair
      FROM osm_places o JOIN districts d ON d.slug = o.district_slug
      WHERE ${withoutAksesBogorData}
        ${filters.q ? sql`AND o.name ILIKE ${`%${escapeLike(filters.q)}%`}` : sql``}
        ${anyOf(sql`o.category::text`, filters.category)}
        ${anyOf(sql`o.district_slug`, filters.district)}
      ORDER BY o.osm_type, o.osm_id
      LIMIT ${CANDIDATE_LIMIT}`),
  );
  const [source] = rowsOf<{ title: string; retrieved_at: Date | string }>(
    await db.execute(sql`SELECT title, retrieved_at FROM knowledge_sources WHERE id = ${FACILITIES_SOURCE_ID}`),
  );
  const candidates: Candidate[] = rows.map((r) => ({
    osm: { osmType: r.osm_type, osmId: Number(r.osm_id) },
    name: r.name,
    category: r.category,
    district: { slug: r.slug, name: r.district },
    location: { lat: Number(r.lat), lng: Number(r.lng) },
    wheelchair: r.wheelchair,
  }));
  return {
    candidates,
    source: {
      title: source?.title ?? "Kampus, masjid, halte, dan rumah sakit di Kota Bogor (OpenStreetMap)",
      license: OSM_LICENSE,
      attribution: "© kontributor OpenStreetMap",
      url: OSM_COPYRIGHT,
      retrievedAt: source ? new Date(source.retrieved_at).toISOString() : null,
    },
  };
}
