// Impor atribut aksesibilitas Google Maps dari dataset Apify ke tag kandidat OSM (ADR-0056). Setiap hasil Google
// dicocokkan seperti cara 2026-11-23: kategori sama, nama mirip (aturan nama ADR-0052), paling jauh 400 m, dan pasangan
// terdekat menang. Hasil yang tidak cocok hanya dilaporkan, jadi tidak pernah ada tempat baru. Salinan yang sudah
// diperiksa tim, atau yang bentuknya tidak dikenal, tidak pernah disentuh, begitu juga tabel `places`. Seperti petunjuk
// lain, isinya tidak pernah diberikan ke AI (ADR-0052).
import { isDeepStrictEqual } from "node:util";
import type { PlaceCategory } from "../contribute/facilities.js";
import { APIFY_ACTOR } from "./apify.js";
import { markers, nameScore, typeFits } from "./match.js";

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
