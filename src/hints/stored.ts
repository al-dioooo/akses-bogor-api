// Petunjuk tersimpan di baris kandidat OSM (ADR-0052): salinan Google Maps di tag `aksesbogor:google_maps` dan
// keterangan OSM di tag `aksesbogor:osm_aksesibilitas`. Sama seperti petunjuk langsung, isinya belum diperiksa tim,
// tidak mengubah status atau jawaban fasilitas, dan modul ini tidak boleh dipakai alat agen atau asisten rute.
import { sql } from "drizzle-orm";
import type { OsmTarget } from "../contribute/facilities.js";
import type { Db } from "../db/client.js";
import type { GoogleHint, ProviderResult } from "./provider.js";
import { wibDate } from "./provider.js";

type Accessibility = GoogleHint["accessibility"];
export type StoredGoogleHint = {
  provider: "google";
  result: "stored";
  placeName: string | null;
  distanceMeters: number | null;
  url: string | null;
  /** Tanggal pengambilan (WIB), YYYY-MM-DD. */
  retrievedAt: string;
  accessibility: Accessibility;
};
export const OSM_WHEELCHAIR = ["yes", "limited", "no", "designated"] as const;
export type StoredOsmHint = { provider: "openstreetmap"; result: "stored"; wheelchair: (typeof OSM_WHEELCHAIR)[number] };
export type StoredHint = StoredGoogleHint | StoredOsmHint;

/** Kunci keterangan OSM tersimpan; salinan Google ada di `GOOGLE_MAPS_TAG` (`google-maps-import.ts`). */
export const OSM_NOTE_TAG = "aksesbogor:osm_aksesibilitas";

/** Objek JSON, juga bila tersimpan sebagai string JSON; null bila bukan objek. */
export function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** Nama opsi aksesibilitas (nama kolom Google atau label Indonesia) menjadi kunci petunjuk, atau null bila tidak dikenal. */
export function optionKey(name: string): keyof Accessibility | null {
  const n = name.toLowerCase();
  if (/seating|duduk/.test(n)) return "seating";
  if (/restroom|toilet|kamar kecil/.test(n)) return "restroom";
  if (/parking|parkir/.test(n)) return "parking";
  if (/entrance|pintu|masuk/.test(n)) return "entrance";
  return null;
}

/** Hanya tautan https ke Google Maps yang ditautkan web. */
function googleMapsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const host = url.hostname;
    return url.protocol === "https:" && (host === "google.com" || host.endsWith(".google.com") || host === "goo.gl" || host.endsWith(".goo.gl")) ? url.href : null;
  } catch {
    return null;
  }
}

/** Salinan Google Maps, atau null bila tidak ada, tanpa tanggal pengambilan, atau tanpa satu pun tanda aksesibilitas. */
export function storedGoogle(value: unknown): StoredGoogleHint | null {
  const data = record(value);
  if (!data) return null;
  const retrieved = typeof data.diambil === "string" ? new Date(data.diambil) : null;
  if (!retrieved || Number.isNaN(retrieved.getTime())) return null;
  const accessibility: Accessibility = { entrance: null, restroom: null, parking: null, seating: null };
  for (const name of strings(data.tidak_tersedia)) {
    const key = optionKey(name);
    if (key) accessibility[key] = false;
  }
  for (const name of strings(data.aksesibilitas)) {
    const key = optionKey(name);
    if (key) accessibility[key] = true;
  }
  if (Object.values(accessibility).every((flag) => flag === null)) return null;
  const meters = typeof data.jarak_titik_m === "number" && Number.isFinite(data.jarak_titik_m) ? Math.round(data.jarak_titik_m) : null;
  return {
    provider: "google",
    result: "stored",
    placeName: typeof data.nama === "string" && data.nama.trim() ? data.nama.trim().slice(0, 200) : null,
    distanceMeters: meters,
    url: googleMapsUrl(data.url),
    retrievedAt: wibDate(retrieved),
    accessibility,
  };
}

/**
 * Keterangan OSM tersimpan, atau null bila nilainya tidak dikenal atau sama dengan tag `wheelchair` tempat itu sendiri,
 * yang sudah ditampilkan kartu kandidat.
 */
export function storedOsm(value: unknown, ownWheelchair: string | null): StoredOsmHint | null {
  const wheelchair = record(value)?.wheelchair;
  if (typeof wheelchair !== "string" || !(OSM_WHEELCHAIR as readonly string[]).includes(wheelchair) || wheelchair === ownWheelchair) return null;
  return { provider: "openstreetmap", result: "stored", wheelchair: wheelchair as StoredOsmHint["wheelchair"] };
}

/** Petunjuk tersimpan satu kandidat OSM. */
export async function storedHints(db: Db, target: OsmTarget): Promise<StoredHint[]> {
  const result = await db.execute(sql`
    SELECT tags->'aksesbogor:google_maps' AS google, tags->'aksesbogor:osm_aksesibilitas' AS osm, tags->>'wheelchair' AS wheelchair
    FROM osm_places WHERE osm_type = ${target.osmType} AND osm_id = ${target.osmId}`);
  const [row] = (result as unknown as { rows: { google: unknown; osm: unknown; wheelchair: string | null }[] }).rows;
  if (!row) return [];
  return [storedGoogle(row.google), storedOsm(row.osm, row.wheelchair)].filter((hint): hint is StoredHint => hint !== null);
}

/** Petunjuk langsung ditambah yang tersimpan. Salinan Google tidak dipakai bila Google langsung menemukan tempatnya. */
export function withStored(live: readonly ProviderResult[], stored: readonly StoredHint[]): (ProviderResult | StoredHint)[] {
  const liveGoogle = live.some((hint) => hint.provider === "google" && hint.result === "found");
  return [...live, ...stored.filter((hint) => !(hint.provider === "google" && liveGoogle))];
}
