// Pencocokan tempat AksesBogor dengan tempat di penyedia peta untuk petunjuk aksesibilitas (ADR-0052): hanya tempat
// penyedia yang dekat, bernama mirip, berjenis sama, dan berkategori sama yang diterima, supaya petunjuk tempat lain
// (mis. rumah sakit di sebelah halte bernama sama) tidak tertempel ke tempat ini.
import type { PlaceCategory } from "../contribute/facilities.js";

export type Point = { lat: number; lng: number };
/** Tempat AksesBogor atau kandidat OSM yang dicari petunjuknya. Tempat tanpa nama tidak dicocokkan. */
export type HintTarget = { name: string | null; location: Point; category: PlaceCategory };
/** Tempat di penyedia: nama, titik, dan kategori penyedia (Mapbox `poi_category_ids`, Google `types`). */
export type ProviderPlace = { name: string; location: Point; categories: readonly string[] };

/** Jarak terjauh tempat penyedia dari titik tempat kita. */
export const MAX_METERS = 75;

/** Singkatan dan padanan bahasa Inggris di nama tempat penyedia, diganti dengan kata Indonesianya. */
const SYNONYMS: Record<string, string[]> = {
  rs: ["rumah", "sakit"],
  rsu: ["rumah", "sakit"],
  rsud: ["rumah", "sakit"],
  rsia: ["rumah", "sakit"],
  rsi: ["rumah", "sakit"],
  hospital: ["rumah", "sakit"],
  hospitals: ["rumah", "sakit"],
  mesjid: ["masjid"],
  mosque: ["masjid"],
  univ: ["universitas"],
  university: ["universitas"],
  institute: ["institut"],
};

/**
 * Kata umum yang tidak membedakan satu tempat dari tempat lain: jenis tempat, nama kota, dan kata sandang Arab di nama
 * masjid (mis. "Al-" di "Masjid Al-Ikhlas" dan "Masjid Al-Hidayah").
 */
const GENERIC = new Set([
  ...["rumah", "sakit", "umum", "daerah", "klinik", "masjid", "musala", "mushola", "musholla", "jami", "kampus", "universitas", "institut", "sekolah", "tinggi"],
  ...["politeknik", "halte", "bus", "stop", "shelter", "bogor", "kota", "kabupaten", "jl", "jalan", "the", "of", "dan", "di"],
  ...["al", "an", "ar", "as", "at", "ash", "el"],
]);

/** Kata jenis tempat di nama penyedia: jenis kategori kita, atau `lain` untuk jenis tempat lain. */
const TYPE_WORDS = new Map<string, PlaceCategory | "lain">([
  ...["halte", "shelter", "bus", "stop"].map((w) => [w, "halte"] as const),
  ["sakit", "rumah_sakit"],
  ...["masjid", "musala", "mushola", "musholla", "mushalla", "surau", "langgar"].map((w) => [w, "masjid"] as const),
  ...["kampus", "universitas", "institut", "politeknik", "akademi", "fakultas", "college", "tinggi"].map((w) => [w, "kampus"] as const),
  ...["terminal", "stasiun", "station", "pasar", "market", "mall", "plaza", "hotel", "apotek", "apotik", "pharmacy", "atm", "bank", "koperasi"].map((w) => [w, "lain"] as const),
  ...["gereja", "church", "vihara", "pura", "klenteng", "kantor", "office", "toko", "store", "restoran", "restaurant", "cafe", "kafe", "warung"].map((w) => [w, "lain"] as const),
  ...["parkir", "parking", "pool", "spbu", "museum", "gor", "lapangan", "gerbang", "gate", "asrama", "klinik", "clinic", "puskesmas", "laboratorium"].map((w) => [w, "lain"] as const),
  ...["sd", "sdn", "smp", "smpn", "sma", "sman", "smk", "smkn", "tk", "paud", "kindergarten"].map((w) => [w, "lain"] as const),
]);

/** Kategori penyedia yang sesuai dengan kategori kita (Mapbox `poi_category_ids` dan Google `types`). */
const PROVIDER_CATEGORIES: Record<PlaceCategory, ReadonlySet<string>> = {
  rumah_sakit: new Set(["hospital", "hospital_unit", "general_hospital", "medical_center", "emergency_room"]),
  masjid: new Set(["mosque", "place_of_worship"]),
  kampus: new Set(["university", "college", "campus"]),
  halte: new Set(["bus_stop", "bus_station", "transit_stop", "transit_station"]),
};

/** Kata sebuah nama: huruf kecil tanpa diakritik, dengan padanan diganti. */
function words(name: string): string[] {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .flatMap((word) => SYNONYMS[word] ?? [word]);
}

/** Penanda yang membedakan tempat bernama sama: angka, huruf tunggal, atau kata berangka (mis. "1", "B", "2a"). */
const isMarker = (word: string) => /\p{N}/u.test(word) || [...word].length === 1;

/** Kata pembeda sebuah nama: tanpa kata umum dan tanpa penanda. */
export function distinctiveWords(name: string): Set<string> {
  return new Set(words(name).filter((word) => !isMarker(word) && !GENERIC.has(word)));
}

/** Angka dan huruf tunggal di nama, mis. {"1"} untuk "Puskesmas X 1". */
export function markers(name: string): Set<string> {
  return new Set(words(name).filter(isMarker));
}

/** Kemiripan 0–1: kata pembeda yang sama dibagi jumlah kata pembeda nama yang lebih panjang. */
export function nameScore(a: string, b: string): number {
  const [left, right] = [distinctiveWords(a), distinctiveWords(b)];
  if (left.size === 0 || right.size === 0) return 0;
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / Math.max(left.size, right.size);
}

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((item) => b.has(item));

/**
 * Jenis di nama penyedia sesuai: setiap kata jenis di nama penyedia harus jenis kategori kita atau juga ada di nama kita.
 * "Terminal Baranangsiang" tidak cocok dengan "Halte Baranangsiang", tetapi cocok dengan "Terminal Baranangsiang".
 */
export function typeFits(category: PlaceCategory, ourName: string, providerName: string): boolean {
  const ours = new Set(words(ourName));
  return words(providerName).every((word) => {
    const kind = TYPE_WORDS.get(word);
    return kind === undefined || kind === category || ours.has(word);
  });
}

/** Kategori penyedia sesuai dengan kategori kita. Tempat penyedia tanpa kategori ditolak. */
export const categoryFits = (category: PlaceCategory, categories: readonly string[]) => categories.some((c) => PROVIDER_CATEGORIES[category].has(c.toLowerCase()));

/** Jarak permukaan bumi dalam meter (haversine). */
export function distanceMeters(a: Point, b: Point): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/**
 * Tempat penyedia yang cocok: paling jauh `MAX_METERS`; kata pembeda yang sama minimal separuh kata pembeda nama yang
 * lebih panjang (setidaknya satu); angka dan huruf tunggal sama persis; jenis di nama penyedia sesuai (`typeFits`); dan
 * kategori penyedia sesuai (`categoryFits`). Yang paling mirip lalu paling dekat menang; null bila tidak ada.
 */
export function pickMatch<T extends ProviderPlace>(target: HintTarget, candidates: readonly T[]): (T & { distanceMeters: number }) | null {
  if (!target.name) return null;
  const name = target.name;
  const ourMarkers = markers(name);
  const scored = candidates
    .filter((candidate) => sameSet(ourMarkers, markers(candidate.name)) && typeFits(target.category, name, candidate.name) && categoryFits(target.category, candidate.categories))
    .map((candidate) => ({ candidate, score: nameScore(name, candidate.name), distance: distanceMeters(target.location, candidate.location) }))
    .filter(({ score, distance }) => score >= 0.5 && distance <= MAX_METERS)
    .sort((a, b) => b.score - a.score || a.distance - b.distance);
  const best = scored[0];
  return best ? { ...best.candidate, distanceMeters: Math.round(best.distance) } : null;
}
