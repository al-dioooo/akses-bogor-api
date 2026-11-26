// Kecamatan paling aksesibel (ADR-0053): per kecamatan, berapa tempat yang punya keterangan pintu masuk dan berapa
// yang bisa dimasuki kursi roda. Tempatnya lokasi AksesBogor yang terbit dan kandidat OSM tanpa data AksesBogor
// (ADR-0049). Setiap tempat dihitung sekali, dengan keterangan dari sumber pertama yang punya keterangan:
//
//   1. data AksesBogor: jawaban Ramp / Jalur Landai (ADR-0018)
//   2. tag `wheelchair` OSM tempat itu
//   3. keterangan OSM tersimpan, lalu 4. salinan Google Maps tersimpan (ADR-0052), hanya selama petunjuk menyala
//
//   skor = bulatkan(100 × bisa dimasuki ÷ punya keterangan), hanya bila paling sedikit MINIMUM_PLACES tempat
//
// Modul ini ada di modul petunjuk karena membaca salinan tersimpan; seperti petunjuk lain, hasilnya tidak pernah
// diberikan ke agen atau asisten rute.
import { sql } from "drizzle-orm";
import { FACILITIES_SOURCE_ID, withoutAksesBogorData } from "../contribute/facilities.js";
import type { Db } from "../db/client.js";
import { storedGoogle, storedOsm } from "./stored.js";

/** Kecamatan dengan tempat ber-keterangan kurang dari ini tidak diberi skor: "Data belum cukup". */
export const MINIMUM_PLACES = 5;
export const ACCESSIBILITY_FORMULA = `skor = 100 × tempat yang pintu masuknya bisa dimasuki kursi roda ÷ tempat yang punya keterangan pintu masuk, dibulatkan; "terbatas" dihitung punya keterangan tetapi tidak bisa dimasuki; kecamatan dengan kurang dari ${MINIMUM_PLACES} tempat ber-keterangan tidak diberi skor.`;
/** Kalimat yang wajib ikut skor; Google Maps hanya disebut bila salinannya dihitung. */
export const accessibilityCaveat = (stored: boolean) =>
  `Keterangan dari ${stored ? "OpenStreetMap dan Google Maps" : "OpenStreetMap"} belum diperiksa tim AksesBogor, dan kriterianya berbeda dari data AksesBogor. Hanya tempat yang punya keterangan pintu masuk yang dihitung.`;

export type Entrance = "bisa" | "terbatas" | "tidak";
export type EntranceSource = "aksesbogor" | "openstreetmap" | "google_maps";
export const ENTRANCE_SOURCES = ["aksesbogor", "openstreetmap", "google_maps"] as const satisfies readonly EntranceSource[];

/** Nilai `wheelchair` OSM menjadi keterangan pintu masuk; nilai lain tidak dihitung. */
export function osmEntrance(value: unknown): Entrance | null {
  if (value === "yes" || value === "designated") return "bisa";
  if (value === "limited") return "terbatas";
  if (value === "no") return "tidak";
  return null;
}

export type PlaceRow =
  | { kind: "aksesbogor"; ramp: string | null }
  | { kind: "osm"; wheelchair: string | null; google: unknown; osmNote: unknown };

/**
 * Keterangan pintu masuk satu tempat dari sumber pertama yang punya keterangan, dengan tanggal pengambilan bila dari
 * salinan Google. Salinan tersimpan hanya dibaca bila `stored` (PROVIDER_HINTS_ENABLED).
 */
export function entranceOf(row: PlaceRow, stored: boolean): { entrance: Entrance; source: EntranceSource; retrievedAt?: string } | null {
  if (row.kind === "aksesbogor") {
    if (row.ramp === "tersedia" || row.ramp === "tidak_perlu") return { entrance: "bisa", source: "aksesbogor" };
    if (row.ramp === "tidak_tersedia") return { entrance: "tidak", source: "aksesbogor" };
    return null;
  }
  const own = osmEntrance(row.wheelchair);
  if (own) return { entrance: own, source: "openstreetmap" };
  if (!stored) return null;
  const note = osmEntrance(storedOsm(row.osmNote, row.wheelchair)?.wheelchair);
  if (note) return { entrance: note, source: "openstreetmap" };
  const google = storedGoogle(row.google);
  if (google && google.accessibility.entrance !== null) return { entrance: google.accessibility.entrance ? "bisa" : "tidak", source: "google_maps", retrievedAt: google.retrievedAt };
  return null;
}

type Tally = { withData: number; accessible: number };
export type DistrictAccessibility = {
  slug: string;
  name: string;
  /** Lokasi AksesBogor terbit ditambah kandidat OSM tanpa data AksesBogor. */
  places: number;
  withData: number;
  accessible: number;
  limited: number;
  notAccessible: number;
  score: number | null;
  rank: number | null;
  bySource: Record<EntranceSource, Tally>;
};

/** Skor dan peringkat dari hitungan per kecamatan: skor tertinggi, lalu tempat ber-keterangan terbanyak, lalu nama. */
export function rankAccessibility(counts: readonly Omit<DistrictAccessibility, "score" | "rank">[]): DistrictAccessibility[] {
  const scored = counts.map((c) => ({ ...c, score: c.withData >= MINIMUM_PLACES ? Math.round((100 * c.accessible) / c.withData) : null }));
  const ranked = scored
    .filter((c) => c.score !== null)
    .sort((a, b) => b.score! - a.score! || b.withData - a.withData || a.name.localeCompare(b.name, "id"))
    .map((c, i) => ({ ...c, rank: i + 1 }));
  const rest = scored.filter((c) => c.score === null).sort((a, b) => a.name.localeCompare(b.name, "id")).map((c) => ({ ...c, rank: null }));
  return [...ranked, ...rest];
}

const rowsOf = <T>(result: unknown) => (result as { rows: T[] }).rows;
type Row = { district: string; name: string; kind: "aksesbogor" | "osm" | null; ramp: string | null; wheelchair: string | null; google: unknown; osm_note: unknown };

/** Kecamatan paling aksesibel dari database, dengan rincian per sumber dan atribusinya. */
export async function districtAccessibility(db: Db, options: { stored: boolean }) {
  const google = options.stored ? sql`o.tags->'aksesbogor:google_maps'` : sql`NULL::jsonb`;
  const osmNote = options.stored ? sql`o.tags->'aksesbogor:osm_aksesibilitas'` : sql`NULL::jsonb`;
  const rows = rowsOf<Row>(
    await db.execute(sql`
      SELECT d.slug AS district, d.name, t.kind, t.ramp, t.wheelchair, t.google, t.osm_note
      FROM districts d LEFT JOIN (
        SELECT p.district_slug, 'aksesbogor' AS kind, f.answer::text AS ramp, NULL AS wheelchair, NULL::jsonb AS google, NULL::jsonb AS osm_note
        FROM places p LEFT JOIN place_facilities f ON f.place_id = p.id AND f.facility = 'ramp'
        WHERE p.unpublished_at IS NULL
        UNION ALL
        SELECT o.district_slug, 'osm', NULL, o.tags->>'wheelchair', ${google}, ${osmNote}
        FROM osm_places o WHERE ${withoutAksesBogorData}
      ) t ON t.district_slug = d.slug
      ORDER BY d.slug`),
  );
  const empty = (): Record<EntranceSource, Tally> => ({ aksesbogor: { withData: 0, accessible: 0 }, openstreetmap: { withData: 0, accessible: 0 }, google_maps: { withData: 0, accessible: 0 } });
  const counts = new Map<string, Omit<DistrictAccessibility, "score" | "rank">>();
  let googleRetrieved: string | null = null;
  for (const row of rows) {
    const district = counts.get(row.district) ?? { slug: row.district, name: row.name, places: 0, withData: 0, accessible: 0, limited: 0, notAccessible: 0, bySource: empty() };
    counts.set(row.district, district);
    if (row.kind === null) continue;
    district.places += 1;
    const place: PlaceRow = row.kind === "aksesbogor" ? { kind: "aksesbogor", ramp: row.ramp } : { kind: "osm", wheelchair: row.wheelchair, google: row.google, osmNote: row.osm_note };
    const found = entranceOf(place, options.stored);
    if (!found) continue;
    district.withData += 1;
    district.bySource[found.source].withData += 1;
    if (found.entrance === "bisa") {
      district.accessible += 1;
      district.bySource[found.source].accessible += 1;
    } else if (found.entrance === "terbatas") district.limited += 1;
    else district.notAccessible += 1;
    if (found.retrievedAt && (!googleRetrieved || found.retrievedAt > googleRetrieved)) googleRetrieved = found.retrievedAt;
  }
  const [osm] = rowsOf<{ retrieved_at: Date | string }>(await db.execute(sql`SELECT retrieved_at FROM knowledge_sources WHERE id = ${FACILITIES_SOURCE_ID}`));
  return {
    minimumPlaces: MINIMUM_PLACES,
    formula: ACCESSIBILITY_FORMULA,
    caveat: accessibilityCaveat(options.stored),
    districts: rankAccessibility([...counts.values()]),
    sources: {
      aksesbogor: { checkedByTeam: true as const },
      openstreetmap: {
        checkedByTeam: false as const,
        attribution: "© kontributor OpenStreetMap",
        url: "https://www.openstreetmap.org/copyright",
        retrievedAt: osm ? new Date(osm.retrieved_at).toISOString() : null,
      },
      // Tanpa petunjuk tersimpan, Google Maps tidak dihitung dan tidak disebut.
      google_maps: options.stored ? { checkedByTeam: false as const, attribution: "Google Maps", retrievedAt: googleRetrieved } : null,
    },
  };
}
