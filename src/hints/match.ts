// Pencocokan tempat AksesBogor dengan tempat di penyedia peta untuk petunjuk aksesibilitas (ADR-0052): hanya tempat
// penyedia yang dekat dan bernama mirip yang diterima, supaya petunjuk tempat lain tidak tertempel ke tempat ini.

export type Point = { lat: number; lng: number };
/** Tempat AksesBogor atau kandidat OSM yang dicari petunjuknya. Tempat tanpa nama tidak dicocokkan. */
export type HintTarget = { name: string | null; location: Point };

/** Jarak terjauh tempat penyedia dari titik tempat kita. */
export const MAX_METERS = 75;

/** Singkatan dan padanan bahasa Inggris di nama tempat penyedia, diganti dengan kata Indonesianya. */
const SYNONYMS: Record<string, string[]> = {
  rs: ["rumah", "sakit"],
  rsu: ["rumah", "sakit"],
  rsud: ["rumah", "sakit"],
  hospital: ["rumah", "sakit"],
  hospitals: ["rumah", "sakit"],
  mesjid: ["masjid"],
  mosque: ["masjid"],
  univ: ["universitas"],
  university: ["universitas"],
};

/**
 * Kata umum yang tidak membedakan satu tempat dari tempat lain: jenis tempat, nama kota, dan kata sandang Arab di nama
 * masjid (mis. "Al-" di "Masjid Al-Ikhlas" dan "Masjid Al-Hidayah").
 */
const GENERIC = new Set([
  ...["rumah", "sakit", "umum", "daerah", "klinik", "masjid", "musala", "mushola", "musholla", "kampus", "universitas", "institut", "sekolah", "tinggi"],
  ...["politeknik", "halte", "bus", "stop", "shelter", "bogor", "kota", "kabupaten", "jl", "jalan", "the", "of", "dan", "di"],
  ...["al", "an", "ar", "as", "at", "ash", "el"],
]);

/** Kata pembeda sebuah nama: huruf kecil tanpa diakritik, padanan diganti, kata umum dan satu huruf dibuang. */
export function distinctiveWords(name: string): Set<string> {
  const words = name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .flatMap((word) => SYNONYMS[word] ?? [word]);
  return new Set(words.filter((word) => word.length > 1 && !GENERIC.has(word)));
}

/** Kemiripan 0–1: kata pembeda yang sama dibagi jumlah kata pembeda nama yang lebih pendek. */
export function nameScore(a: string, b: string): number {
  const [left, right] = [distinctiveWords(a), distinctiveWords(b)];
  if (left.size === 0 || right.size === 0) return 0;
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / Math.min(left.size, right.size);
}

/** Jarak permukaan bumi dalam meter (haversine). */
export function distanceMeters(a: Point, b: Point): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/**
 * Tempat penyedia yang cocok: paling jauh `MAX_METERS` dan minimal separuh kata pembeda nama yang lebih pendek sama
 * (setidaknya satu). Yang paling mirip lalu paling dekat menang; null bila tidak ada.
 */
export function pickMatch<T extends { name: string; location: Point }>(target: HintTarget, candidates: readonly T[]): (T & { distanceMeters: number }) | null {
  if (!target.name) return null;
  const name = target.name;
  const scored = candidates
    .map((candidate) => ({ candidate, score: nameScore(name, candidate.name), distance: distanceMeters(target.location, candidate.location) }))
    .filter(({ score, distance }) => score >= 0.5 && distance <= MAX_METERS)
    .sort((a, b) => b.score - a.score || a.distance - b.distance);
  const best = scored[0];
  return best ? { ...best.candidate, distanceMeters: Math.round(best.distance) } : null;
}
