// Pengambilan atribut aksesibilitas Google Maps untuk kandidat OSM lewat aktor Apify `compass/crawler-google-places`
// (ADR-0056), dengan cara alat ulasan Google Maps tim: jalankan aktor, lalu simpan dataset mentahnya di luar repo.
// Modul ini menyusun daftar pencarian, input aktor, perkiraan biaya, dan membaca token. Seperti petunjuk lain, hasilnya
// tidak pernah diberikan ke AI (ADR-0052).
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { sql } from "drizzle-orm";
import { FACILITIES_SOURCE_ID, type PlaceCategory } from "../contribute/facilities.js";
import type { Db } from "../db/client.js";
import { distinctiveWords } from "./match.js";

export const APIFY_ACTOR = "compass/crawler-google-places";
/** Harga satu tempat (event `place-scraped`) di paket Free Apify per 2026-11-26. Paket Starter $0,003. */
export const PRICE_PER_PLACE_USD = 0.004;
/** Batas biaya terkecil yang diterima aktor ini untuk satu run. */
export const MIN_CHARGE_USD = 0.5;
/** Zoom peta pencarian: sekitar satu kelurahan, supaya Google mengurutkan hasil di sekitar titik OSM. */
export const SEARCH_ZOOM = 17;
/** Folder dataset mentah, di luar repo. */
export const DEFAULT_OUTPUT_DIR = join(homedir(), "data/akses-bogor/google-maps");
/** Berkas token bawaan; bisa diganti dengan env `APIFY_ENV_FILE`. */
export const DEFAULT_TOKEN_FILE = join(homedir(), "credentials/akses-bogor/apify.env");

export type SearchPlace = { osmType: string; osmId: number; category: PlaceCategory; name: string; lat: number; lng: number };
export type SearchPlan = { places: SearchPlace[]; unnamed: number; generic: number };

/**
 * Tempat OSM yang dicari di Google Maps: yang bernama dan punya kata pembeda, karena hanya itu yang bisa lolos syarat nama
 * saat impor ("Mushola" atau "Halte Bus" saja tidak pernah cocok). Urutannya bergiliran per kategori, supaya `limit`
 * kecil tetap mencakup keempat kategori.
 */
export async function searchPlan(db: Db, limit?: number): Promise<SearchPlan> {
  const result = await db.execute(sql`
    SELECT osm_type, osm_id, category, name, ST_Y(location) AS lat, ST_X(location) AS lng
    FROM osm_places WHERE source_id = ${FACILITIES_SOURCE_ID}
    ORDER BY category, name, osm_type, osm_id`);
  const rows = (result as unknown as { rows: { osm_type: string; osm_id: number | string; category: PlaceCategory; name: string | null; lat: number; lng: number }[] }).rows;
  const named = rows.filter((r) => r.name);
  const usable = named.filter((r) => distinctiveWords(r.name!).size > 0);
  const byCategory = new Map<PlaceCategory, SearchPlace[]>();
  for (const r of usable) {
    const list = byCategory.get(r.category) ?? [];
    list.push({ osmType: r.osm_type, osmId: Number(r.osm_id), category: r.category, name: r.name!, lat: Number(r.lat), lng: Number(r.lng) });
    byCategory.set(r.category, list);
  }
  const places: SearchPlace[] = [];
  const lists = [...byCategory.values()];
  for (let i = 0; places.length < usable.length; i += 1) for (const list of lists) if (list[i]) places.push(list[i]!);
  return { places: limit === undefined ? places : places.slice(0, limit), unnamed: rows.length - named.length, generic: named.length - usable.length };
}

/** URL pencarian Google Maps untuk nama tempat di sekitar titiknya, dalam bahasa Indonesia. */
export function searchUrl(place: SearchPlace): string {
  return `https://www.google.com/maps/search/${encodeURIComponent(place.name)}/@${place.lat.toFixed(6)},${place.lng.toFixed(6)},${SEARCH_ZOOM}z?hl=id`;
}

/**
 * Input aktor: satu URL pencarian per tempat, `perPlace` hasil teratas Google per pencarian, bahasa Indonesia. Semua
 * tambahan berbayar dan data pribadi mati; grup "Aksesibilitas" ada di `additionalInfo` tanpa tambahan apa pun.
 */
export function actorInput(places: readonly SearchPlace[], perPlace: number) {
  return {
    startUrls: places.map((place) => ({ url: searchUrl(place) })),
    maxCrawledPlacesPerSearch: perPlace,
    language: "id",
    searchMatching: "all",
    skipClosedPlaces: false,
    scrapePlaceDetailPage: false,
    scrapeTableReservationProvider: false,
    scrapeOrderOnline: false,
    includeWebResults: false,
    scrapeDirectories: false,
    maxQuestions: 0,
    scrapeContacts: false,
    maximumLeadsEnrichmentRecords: 0,
    maxReviews: 0,
    scrapeReviewsPersonalData: false,
    maxImages: 0,
    scrapeImageAuthors: false,
    enableCompetitorAnalysis: false,
  };
}

/** Perkiraan biaya terbesar: setiap pencarian menghasilkan `perPlace` tempat. */
export const estimateUsd = (searches: number, perPlace: number) => searches * perPlace * PRICE_PER_PLACE_USD;

/** Batas biaya run (`maxTotalChargeUsd`): perkiraan ditambah setengahnya, dibulatkan ke atas per sen, minimal batas aktor. */
export const chargeLimitUsd = (estimate: number) => Math.max(MIN_CHARGE_USD, Math.ceil(estimate * 150) / 100);

/** Token Apify dari env `APIFY_TOKEN`, atau dari berkas env; null bila tidak ada. Nilainya tidak pernah dicetak. */
export async function apifyToken(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const direct = env.APIFY_TOKEN?.trim();
  if (direct) return direct;
  let text: string;
  try {
    text = await readFile(env.APIFY_ENV_FILE || DEFAULT_TOKEN_FILE, "utf8");
  } catch {
    return null;
  }
  return parseEnv(text).APIFY_TOKEN?.trim() || null;
}
