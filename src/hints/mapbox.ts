// Petunjuk aksesibilitas dari Mapbox Search Box (ADR-0052): `forward` mencari tempat bernama sama di sekitar titik,
// lalu `retrieve` membaca `metadata.wheelchair_accessible` tempat yang cocok (kolom ini tidak ada di `forward`). Token
// rahasia yang sama dengan pencarian tempat (ADR-0032) dipakai dari server.
//
// Syarat Mapbox: hasil Search Box tidak disimpan di database, hanya di memori proses selama `ttlMs` (bawaan 10 menit,
// paling banyak 500 entri), dan tidak pernah menjadi masukan AI (Product Terms §1.5).
import { randomUUID } from "node:crypto";
import { KOTA_BOGOR_BBOX } from "../map/search.js";
import { pickMatch, type HintTarget, type Point } from "./match.js";
import { dailyBudget, type HintProvider, type ProviderResult } from "./provider.js";

const BASE = "https://api.mapbox.com/search/searchbox/v1";
const CACHE_LIMIT = 500;
/** Pencarian petunjuk per hari WIB; satu pencarian berarti `forward` dan, bila ada yang cocok, `retrieve`. */
export const MAPBOX_HINTS_PER_DAY = 1000;

type Options = { token: string; now: () => Date; fetch?: typeof fetch; perDay?: number; ttlMs?: number };
type Feature = { geometry?: { coordinates?: [number, number] }; properties?: { name?: string; mapbox_id?: string; metadata?: { wheelchair_accessible?: unknown } } };

export function mapboxHints({ token, now, fetch = globalThis.fetch, perDay = MAPBOX_HINTS_PER_DAY, ttlMs = 10 * 60_000 }: Options): HintProvider {
  const cache = new Map<string, { at: number; result: ProviderResult }>();
  const spend = dailyBudget(perDay, now);

  async function features(url: URL): Promise<Feature[]> {
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    } catch {
      // Dibuat ulang tanpa URL, karena URL-nya memuat token rahasia.
      throw new Error("Mapbox Search Box tidak bisa dihubungi");
    }
    const body = (await response.json().catch(() => null)) as { features?: Feature[] } | null;
    if (!response.ok || !Array.isArray(body?.features)) throw new Error(`Mapbox Search Box menjawab ${response.status}`);
    return body.features;
  }

  async function search(target: HintTarget & { name: string }): Promise<ProviderResult> {
    const forward = new URL(`${BASE}/forward`);
    forward.search = new URLSearchParams({
      q: target.name,
      access_token: token,
      proximity: `${target.location.lng},${target.location.lat}`,
      bbox: KOTA_BOGOR_BBOX.join(","),
      country: "id",
      language: "id",
      types: "poi",
      limit: "5",
    }).toString();
    const places = (await features(forward)).flatMap((feature) => {
      const [lng, lat] = feature.geometry?.coordinates ?? [];
      const { name, mapbox_id: id } = feature.properties ?? {};
      return typeof lng === "number" && typeof lat === "number" && name && id ? [{ id, name, location: { lat, lng } satisfies Point }] : [];
    });
    const match = pickMatch(target, places);
    if (!match) return { provider: "mapbox", result: "none" };
    const retrieve = new URL(`${BASE}/retrieve/${encodeURIComponent(match.id)}`);
    retrieve.search = new URLSearchParams({ access_token: token, session_token: randomUUID(), language: "id" }).toString();
    const [detail] = await features(retrieve);
    const accessible = detail?.properties?.metadata?.wheelchair_accessible;
    if (typeof accessible !== "boolean") return { provider: "mapbox", result: "none" };
    return { provider: "mapbox", result: "found", placeName: match.name, distanceMeters: match.distanceMeters, wheelchairAccessible: accessible };
  }

  return {
    name: "mapbox",
    async lookup(target) {
      if (!target.name) return { provider: "mapbox", result: "none" };
      const key = `${target.name.trim().toLowerCase()}|${target.location.lat.toFixed(5)},${target.location.lng.toFixed(5)}`;
      const cached = cache.get(key);
      if (cached && now().getTime() - cached.at < ttlMs) return cached.result;
      if (!spend()) return { provider: "mapbox", result: "unavailable" };
      // Galat tidak di-cache, supaya permintaan berikutnya mencoba lagi.
      const result = await search({ ...target, name: target.name });
      cache.delete(key);
      cache.set(key, { at: now().getTime(), result });
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      return result;
    },
  };
}
