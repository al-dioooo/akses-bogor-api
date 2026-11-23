// Bentuk hasil petunjuk per penyedia (ADR-0052). Hasilnya hanya tanda aksesibilitas, nama penyedia, nama tempat di
// penyedia, jaraknya, dan tautan halaman tempat bila ada. Tidak ada yang disimpan di database, dan modul ini tidak
// boleh dipakai alat agen atau asisten rute (Product Terms Mapbox §1.5; Google ikut dikeluarkan).
import type { HintTarget } from "./match.js";

export type MapboxHint = { provider: "mapbox"; result: "found"; placeName: string; distanceMeters: number; wheelchairAccessible: boolean };
export type GoogleHint = {
  provider: "google";
  result: "found";
  placeName: string;
  distanceMeters: number;
  url: string | null;
  accessibility: { entrance: boolean | null; restroom: boolean | null; parking: boolean | null; seating: boolean | null };
};
/** `none`: tidak ada tempat yang cocok atau tempat itu tanpa tanda aksesibilitas; `unavailable`: penyedia gagal atau batas harian habis. */
export type ProviderResult = MapboxHint | GoogleHint | { provider: "mapbox" | "google"; result: "none" | "unavailable" };

export type HintProvider = { name: "mapbox" | "google"; lookup: (target: HintTarget) => Promise<ProviderResult> };

/** Tanggal di WIB (UTC+7), supaya batas harian dihitung ulang tengah malam WIB. */
export const wibDate = (date: Date) => new Date(date.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** Batas harian per penyedia, dihitung di memori proses: setiap pencarian ke penyedia berbayar. */
export function dailyBudget(perDay: number, now: () => Date) {
  let day = "";
  let used = 0;
  return () => {
    const today = wibDate(now());
    if (today !== day) [day, used] = [today, 0];
    if (used >= perDay) return false;
    used += 1;
    return true;
  };
}

/** Petunjuk dari semua penyedia yang menyala, bersamaan. Penyedia yang gagal tidak menggagalkan yang lain. */
export async function lookupHints(target: HintTarget, providers: readonly HintProvider[]): Promise<ProviderResult[]> {
  if (!target.name) return providers.map((p) => ({ provider: p.name, result: "none" as const }));
  return Promise.all(providers.map((p) => p.lookup(target).catch(() => ({ provider: p.name, result: "unavailable" as const }))));
}
