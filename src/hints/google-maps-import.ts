// Impor atribut aksesibilitas Google Maps dari dataset Apify ke tag kandidat OSM (ADR-0056). Setiap hasil Google
// dicocokkan seperti cara 2026-11-23: kategori sama, nama mirip (aturan nama ADR-0052), paling jauh 400 m, dan pasangan
// terdekat menang. Hasil yang tidak cocok hanya dilaporkan, jadi tidak pernah ada tempat baru. Salinan yang sudah
// diperiksa tim, atau yang bentuknya tidak dikenal, tidak pernah disentuh, begitu juga tabel `places`. Seperti petunjuk
// lain, isinya tidak pernah diberikan ke AI (ADR-0052).
import { isDeepStrictEqual } from "node:util";
import { sql } from "drizzle-orm";
import { FACILITIES_SOURCE_ID, withoutAksesBogorData, type PlaceCategory } from "../contribute/facilities.js";
import type { Db } from "../db/client.js";
import { APIFY_ACTOR } from "./apify.js";
import { markers, nameScore, typeFits } from "./match.js";
import { optionKey } from "./stored.js";

export const GOOGLE_MAPS_TAG = "aksesbogor:google_maps";
/** Jarak terjauh hasil Google dari titik OSM, sama dengan pencocokan dengan tangan 2026-11-23. */
export const MATCH_METERS = 400;
/** Nilai `metode` salinan dari impor ini. Salinan dengan metode lain tidak ditimpa kecuali diminta. */
export const IMPORT_METHOD = `apify:${APIFY_ACTOR}`;

export type GooglePlace = {
  placeId: string;
  name: string;
  location: { lat: number; lng: number };
  categories: string[];
  retrievedAt: Date;
  /** Label grup Aksesibilitas apa adanya: yang ada (true) dan yang tidak ada (false). */
  available: string[];
  unavailable: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const ACCESSIBILITY_GROUP = /^(accessibility|aksesibilitas)$/i;

/** Grup "Aksesibilitas" (atau "Accessibility") dari `additionalInfo`: larik objek `{ label: boolean }`. Grup lain dibuang. */
function accessibility(info: unknown) {
  const available: string[] = [];
  const unavailable: string[] = [];
  if (!isRecord(info)) return { available, unavailable };
  for (const [group, entries] of Object.entries(info)) {
    if (!ACCESSIBILITY_GROUP.test(group.trim()) || !Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      for (const [label, value] of Object.entries(entry)) {
        const name = label.trim().slice(0, 120);
        const list = value === true ? available : value === false ? unavailable : null;
        if (name && list && !list.includes(name)) list.push(name);
      }
    }
  }
  return { available, unavailable };
}

/**
 * Hasil aktor menjadi tempat Google, satu per `placeId` (yang paling baru diambil). Hasil tanpa nama, titik, `placeId`,
 * atau waktu ambil dibuang, begitu juga tempat yang tutup permanen. `fallbackRetrievedAt` dipakai bila hasil tanpa
 * `scrapedAt`, mis. waktu selesai run dari `.meta.json`.
 */
export function parseApifyItems(items: unknown, fallbackRetrievedAt?: Date) {
  const byId = new Map<string, GooglePlace>();
  const skipped = { incomplete: 0, closed: 0, duplicates: 0 };
  for (const item of Array.isArray(items) ? items : []) {
    const location = isRecord(item) && isRecord(item.location) ? item.location : null;
    const scraped = isRecord(item) && text(item.scrapedAt) ? new Date(item.scrapedAt as string) : fallbackRetrievedAt;
    if (!isRecord(item) || !text(item.placeId) || !text(item.title) || typeof location?.lat !== "number" || typeof location.lng !== "number" || !scraped || Number.isNaN(scraped.getTime())) {
      skipped.incomplete += 1;
      continue;
    }
    if (item.permanentlyClosed === true) {
      skipped.closed += 1;
      continue;
    }
    const categories = [item.categoryName, ...(Array.isArray(item.categories) ? item.categories : [])].map(text).filter((c): c is string => c !== null);
    const place: GooglePlace = {
      placeId: text(item.placeId)!,
      name: text(item.title)!.slice(0, 200),
      location: { lat: location.lat, lng: location.lng as number },
      categories: [...new Set(categories)],
      retrievedAt: scraped,
      ...accessibility(item.additionalInfo),
    };
    const previous = byId.get(place.placeId);
    if (previous) skipped.duplicates += 1;
    if (!previous || previous.retrievedAt < place.retrievedAt) byId.set(place.placeId, place);
  }
  return { places: [...byId.values()], skipped };
}

/** Kata kategori Google Maps (bahasa Indonesia, juga Inggris) untuk keempat kategori kita. */
const CATEGORY_WORDS: Record<PlaceCategory, RegExp> = {
  kampus: /\b(universitas|university|perguruan tinggi|sekolah tinggi|institut|institute|politeknik|polytechnic|akademi|academy|college|kampus|campus)\b/,
  masjid: /\b(masjid|mesjid|mosque|musala|mushola|musholla|mushalla|surau|langgar|tempat ibadah|place of worship)\b/,
  halte: /\b(halte|bus stop|perhentian bus|pemberhentian bus|stasiun bus|bus station|terminal bus)\b/,
  rumah_sakit: /\b(rumah sakit|hospital)\b/,
};
/** Kategori yang memakai kata di atas tetapi bukan tempat kita, mis. "Rumah sakit hewan". */
const NOT_OURS = /\b(hewan|animal|veteriner|veterinary)\b/;

/** Kategori kita yang sesuai dengan kategori Google sebuah tempat; kosong bila tidak ada. */
export function googleCategories(categories: readonly string[]): Set<PlaceCategory> {
  const ours = new Set<PlaceCategory>();
  for (const category of categories) {
    const name = category.toLowerCase();
    if (NOT_OURS.test(name)) continue;
    for (const [ourCategory, words] of Object.entries(CATEGORY_WORDS)) if (words.test(name)) ours.add(ourCategory as PlaceCategory);
  }
  return ours;
}

/** Tempat OSM bernama dalam `MATCH_METERS` dari hasil Google ke-`place`. */
export type NearbyRow = { place: number; osmType: string; osmId: number; category: PlaceCategory; name: string; meters: number };
export type Match = { place: GooglePlace; osm: Omit<NearbyRow, "place" | "meters">; meters: number };
/**
 * Alasan tidak cocok: `kategori` (kategori Google bukan salah satu dari empat), `jarak` (tidak ada tempat OSM berkategori
 * sama dalam 400 m), `nama` (ada, tetapi namanya tidak mirip), `ambigu` (semua tempat OSM yang cocok sudah diambil hasil
 * Google lain yang lebih dekat).
 */
export type Unmatched = { place: GooglePlace; reason: "kategori" | "jarak" | "nama" | "ambigu" };

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((item) => b.has(item));

/** Nama mirip menurut aturan ADR-0052: kata pembeda, angka dan huruf tunggal, dan kata jenis tempat. */
export const similarName = (category: PlaceCategory, osmName: string, googleName: string) =>
  sameSet(markers(osmName), markers(googleName)) && typeFits(category, osmName, googleName) && nameScore(osmName, googleName) >= 0.5;

/**
 * Pasangan hasil Google dan tempat OSM. Semua pasangan yang lolos syarat diurutkan dari yang terdekat, lalu diambil satu per
 * satu selama hasil Google dan tempat OSM-nya belum dipakai, jadi setiap tempat OSM mendapat hasil Google terdekatnya dan
 * sebaliknya.
 */
export function matchPlaces(places: readonly GooglePlace[], nearby: readonly NearbyRow[]): { matches: Match[]; unmatched: Unmatched[] } {
  const unmatched: Unmatched[] = [];
  const pairs: NearbyRow[] = [];
  places.forEach((place, index) => {
    const ours = googleCategories(place.categories);
    if (ours.size === 0) return unmatched.push({ place, reason: "kategori" });
    const sameCategory = nearby.filter((row) => row.place === index && ours.has(row.category));
    if (sameCategory.length === 0) return unmatched.push({ place, reason: "jarak" });
    const similar = sameCategory.filter((row) => similarName(row.category, row.name, place.name));
    if (similar.length === 0) return unmatched.push({ place, reason: "nama" });
    pairs.push(...similar);
  });
  pairs.sort((a, b) => a.meters - b.meters || a.osmType.localeCompare(b.osmType) || a.osmId - b.osmId || a.place - b.place);
  const usedPlaces = new Set<number>();
  const usedOsm = new Set<string>();
  const matches: Match[] = [];
  for (const { place, meters, ...osm } of pairs) {
    const ref = `${osm.osmType}/${osm.osmId}`;
    if (usedPlaces.has(place) || usedOsm.has(ref)) continue;
    usedPlaces.add(place);
    usedOsm.add(ref);
    matches.push({ place: places[place]!, osm, meters });
  }
  const withPairs = new Set(pairs.map((pair) => pair.place));
  for (const index of withPairs) if (!usedPlaces.has(index)) unmatched.push({ place: places[index]!, reason: "ambigu" });
  return { matches, unmatched };
}

/** Isi tag `aksesbogor:google_maps`, dalam bentuk yang dibaca `storedGoogle` di stored.ts. */
export function tagValue(match: Match) {
  const { place } = match;
  return {
    sumber: "Google Maps",
    nama: place.name,
    url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.name)}&query_place_id=${encodeURIComponent(place.placeId)}`,
    place_id: place.placeId,
    aksesibilitas: place.available,
    tidak_tersedia: place.unavailable,
    diambil: place.retrievedAt.toISOString(),
    metode: IMPORT_METHOD,
    jarak_titik_m: Math.round(match.meters),
    belum_diperiksa_tim: true,
  };
}
export type TagValue = ReturnType<typeof tagValue>;

/**
 * Apa yang dilakukan pada satu tempat yang cocok: `baru` dan `diperbarui` ditulis. Tidak ditulis: `sama` (isi sama),
 * `tanpa_atribut` (Google tidak punya grup Aksesibilitas untuk tempat ini), `dilindungi` (salinan lama sudah diperiksa
 * tim atau bentuknya tidak dikenal), `cara_lain` (salinan lama dari cara lain, mis. 2026-11-23), `lebih_baru` (salinan
 * lama dari impor ini lebih baru).
 */
export type Decision = "baru" | "diperbarui" | "sama" | "tanpa_atribut" | "dilindungi" | "cara_lain" | "lebih_baru";

function existingRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return isRecord(value) ? value : null;
  try {
    return existingRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

export function decide(existing: unknown, value: TagValue, options: { replaceOtherMethods?: boolean } = {}): Decision {
  if (value.aksesibilitas.length + value.tidak_tersedia.length === 0) return "tanpa_atribut";
  if (existing === null || existing === undefined) return "baru";
  const old = existingRecord(existing);
  if (old?.belum_diperiksa_tim !== true) return "dilindungi";
  if (old.metode !== IMPORT_METHOD) return options.replaceOtherMethods ? "diperbarui" : "cara_lain";
  if (typeof old.diambil === "string" && new Date(old.diambil) > new Date(value.diambil)) return "lebih_baru";
  return isDeepStrictEqual(old, value) ? "sama" : "diperbarui";
}

export type ImportedMatch = Match & { decision: Decision; hasAksesBogorData: boolean; value: TagValue };
export type ImportReport = { matches: ImportedMatch[]; unmatched: Unmatched[]; written: number };

const rowsOf = <T>(result: unknown) => (result as { rows: T[] }).rows;

/**
 * Mencocokkan `places` ke `osm_places` dan menulis tag yang `baru` atau `diperbarui`, dalam satu transaksi. Dengan
 * `dryRun`, tidak ada yang ditulis. Hanya baris OSM yang sudah ada yang diubah, dan hanya tag `aksesbogor:google_maps`-nya.
 * Kandidat di `exclude` (mis. "node/123"), yaitu pasangan yang salah menurut pemeriksa dry run, tidak pernah dipasangkan.
 */
export async function importGoogleMaps(
  db: Db,
  places: readonly GooglePlace[],
  options: { dryRun: boolean; replaceOtherMethods?: boolean; exclude?: ReadonlySet<string> },
): Promise<ImportReport> {
  return db.transaction(async (tx) => {
    const points = JSON.stringify(places.map((place, i) => ({ i, lat: place.location.lat, lng: place.location.lng })));
    const nearby = rowsOf<{ place: number; osm_type: string; osm_id: number | string; category: PlaceCategory; name: string; meters: number }>(
      await tx.execute(sql`
        SELECT g.i AS place, o.osm_type, o.osm_id, o.category, o.name,
          ST_Distance(o.location::geography, ST_SetSRID(ST_MakePoint(g.lng, g.lat), 4326)::geography) AS meters
        FROM jsonb_to_recordset(${points}::jsonb) AS g(i int, lat float8, lng float8)
        JOIN osm_places o ON o.source_id = ${FACILITIES_SOURCE_ID} AND o.name IS NOT NULL
          AND ST_DWithin(o.location::geography, ST_SetSRID(ST_MakePoint(g.lng, g.lat), 4326)::geography, ${MATCH_METERS})`),
    )
      .map((r) => ({ place: Number(r.place), osmType: r.osm_type, osmId: Number(r.osm_id), category: r.category, name: r.name, meters: Number(r.meters) }))
      .filter((row) => !options.exclude?.has(`${row.osmType}/${row.osmId}`));
    const { matches, unmatched } = matchPlaces(places, nearby);
    if (matches.length === 0) return { matches: [], unmatched, written: 0 };

    const refs = JSON.stringify(matches.map((m) => ({ osm_type: m.osm.osmType, osm_id: m.osm.osmId })));
    const current = rowsOf<{ osm_type: string; osm_id: number | string; existing: unknown; has_data: boolean }>(
      await tx.execute(sql`
        SELECT o.osm_type, o.osm_id, o.tags->${GOOGLE_MAPS_TAG} AS existing, NOT (${withoutAksesBogorData}) AS has_data
        FROM osm_places o JOIN jsonb_to_recordset(${refs}::jsonb) AS r(osm_type text, osm_id bigint) ON o.osm_type = r.osm_type AND o.osm_id = r.osm_id
        ${options.dryRun ? sql`` : sql`FOR UPDATE OF o`}`),
    );
    const byRef = new Map(current.map((r) => [`${r.osm_type}/${r.osm_id}`, r]));
    const imported = matches.map((match): ImportedMatch => {
      const row = byRef.get(`${match.osm.osmType}/${match.osm.osmId}`);
      const value = tagValue(match);
      return { ...match, value, decision: decide(row?.existing, value, options), hasAksesBogorData: row?.has_data === true };
    });

    const writes = imported.filter((m) => m.decision === "baru" || m.decision === "diperbarui");
    if (!options.dryRun && writes.length > 0) {
      const values = JSON.stringify(writes.map((m) => ({ osm_type: m.osm.osmType, osm_id: m.osm.osmId, value: m.value })));
      await tx.execute(sql`
        UPDATE osm_places o SET tags = o.tags || jsonb_build_object(${GOOGLE_MAPS_TAG}::text, r.value)
        FROM jsonb_to_recordset(${values}::jsonb) AS r(osm_type text, osm_id bigint, value jsonb)
        WHERE o.osm_type = r.osm_type AND o.osm_id = r.osm_id`);
    }
    return { matches: imported, unmatched, written: options.dryRun ? 0 : writes.length };
  });
}

type Flag = NonNullable<ReturnType<typeof optionKey>>;
export type CategorySummary = { cocok: number; denganAtribut: number; flags: Record<Flag, { ada: number; tidak: number }>; lain: number };

/** Ringkasan untuk dry run: hasil per keputusan dan per alasan, dan atribut yang ditemukan per kategori. */
export function summarize(report: ImportReport) {
  const decisions = Object.fromEntries((["baru", "diperbarui", "sama", "tanpa_atribut", "dilindungi", "cara_lain", "lebih_baru"] as const).map((d) => [d, 0])) as Record<Decision, number>;
  const reasons: Record<Unmatched["reason"], number> = { kategori: 0, jarak: 0, nama: 0, ambigu: 0 };
  const categories = new Map<PlaceCategory, CategorySummary>();
  for (const m of report.matches) {
    decisions[m.decision] += 1;
    const c = categories.get(m.osm.category) ?? { cocok: 0, denganAtribut: 0, flags: { entrance: { ada: 0, tidak: 0 }, restroom: { ada: 0, tidak: 0 }, parking: { ada: 0, tidak: 0 }, seating: { ada: 0, tidak: 0 } }, lain: 0 };
    c.cocok += 1;
    if (m.place.available.length + m.place.unavailable.length > 0) c.denganAtribut += 1;
    for (const [labels, side] of [[m.place.available, "ada"], [m.place.unavailable, "tidak"]] as const) {
      for (const label of labels) {
        const key = optionKey(label);
        if (key) c.flags[key][side] += 1;
        else c.lain += 1;
      }
    }
    categories.set(m.osm.category, c);
  }
  for (const u of report.unmatched) reasons[u.reason] += 1;
  return { decisions, reasons, categories, withAksesBogorData: report.matches.filter((m) => m.hasAksesBogorData).length };
}
