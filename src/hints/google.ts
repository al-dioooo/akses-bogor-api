// Petunjuk aksesibilitas dari Google Places API (New) lewat API resmi (ADR-0052), hanya bila `GOOGLE_MAPS_API_KEY`
// diisi. Text Search mencari tempat bernama sama di sekitar titik dengan field mask yang memuat `accessibilityOptions`.
//
// Syarat Google Maps Platform: hanya `place_id` yang boleh disimpan, jadi yang di-cache di memori hanya `place_id` tempat
// yang cocok (paling lama `idTtlMs`). Isi lain, termasuk `accessibilityOptions`, nama, lokasi, dan tautan, diambil ulang
// lewat Place Details setiap kali diminta, tidak di-cache, tidak disimpan di database, dan tidak menjadi masukan AI.
// Web wajib menampilkan atribusi Google Maps di dekat isinya.
import { pickMatch, type HintTarget, type Point } from "./match.js";
import { dailyBudget, type GoogleHint, type HintProvider, type ProviderResult } from "./provider.js";

const BASE = "https://places.googleapis.com/v1";
const PLACE_FIELDS = ["id", "displayName", "location", "googleMapsUri", "accessibilityOptions"];
/** Pencarian petunjuk per hari WIB; setiap pencarian satu panggilan Text Search atau Place Details. */
export const GOOGLE_HINTS_PER_DAY = 1000;
/** Bias lokasi Text Search, sedikit lebih luas dari jarak cocok supaya tempat yang sama pasti ikut. */
const BIAS_METERS = 200;

type Options = { apiKey: string; now: () => Date; fetch?: typeof fetch; perDay?: number; idTtlMs?: number };
type Place = {
  id?: string;
  displayName?: { text?: string };
  location?: { latitude?: number; longitude?: number };
  googleMapsUri?: string;
  accessibilityOptions?: { wheelchairAccessibleEntrance?: boolean; wheelchairAccessibleRestroom?: boolean; wheelchairAccessibleParking?: boolean; wheelchairAccessibleSeating?: boolean };
};

const flag = (value: unknown) => (typeof value === "boolean" ? value : null);

export function googleHints({ apiKey, now, fetch = globalThis.fetch, perDay = GOOGLE_HINTS_PER_DAY, idTtlMs = 24 * 60 * 60_000 }: Options): HintProvider {
  // Hanya `place_id` (atau "tidak ada yang cocok"), tidak pernah isi tempat.
  const ids = new Map<string, { at: number; placeId: string | null }>();
  const spend = dailyBudget(perDay, now);

  async function call(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
    } catch {
      throw new Error("Google Places API tidak bisa dihubungi");
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Google Places API menjawab ${response.status}`);
    return body;
  }

  const headers = (fields: string[]) => ({ "content-type": "application/json", "x-goog-api-key": apiKey, "x-goog-fieldmask": fields.join(",") });
  const placeOf = (place: Place) => {
    const { latitude: lat, longitude: lng } = place.location ?? {};
    const name = place.displayName?.text;
    return place.id && name && typeof lat === "number" && typeof lng === "number" ? { ...place, id: place.id, name, location: { lat, lng } satisfies Point } : null;
  };

  function hint(place: NonNullable<ReturnType<typeof placeOf>>, distanceMeters: number): ProviderResult {
    const options = place.accessibilityOptions ?? {};
    const accessibility: GoogleHint["accessibility"] = {
      entrance: flag(options.wheelchairAccessibleEntrance),
      restroom: flag(options.wheelchairAccessibleRestroom),
      parking: flag(options.wheelchairAccessibleParking),
      seating: flag(options.wheelchairAccessibleSeating),
    };
    if (Object.values(accessibility).every((value) => value === null)) return { provider: "google", result: "none" };
    return { provider: "google", result: "found", placeName: place.name, distanceMeters, url: place.googleMapsUri ?? null, accessibility };
  }

  return {
    name: "google",
    async lookup(target: HintTarget) {
      if (!target.name) return { provider: "google", result: "none" };
      const key = `${target.name.trim().toLowerCase()}|${target.location.lat.toFixed(5)},${target.location.lng.toFixed(5)}`;
      const known = ids.get(key);
      const fresh = known && now().getTime() - known.at < idTtlMs ? known : null;
      if (fresh && fresh.placeId === null) return { provider: "google", result: "none" };
      if (!spend()) return { provider: "google", result: "unavailable" };

      if (fresh?.placeId) {
        // Isi tempat diambil ulang setiap kali; hanya place_id yang diingat.
        const place = placeOf((await call(`${BASE}/places/${encodeURIComponent(fresh.placeId)}`, { headers: headers(PLACE_FIELDS) })) as Place);
        if (!place) return { provider: "google", result: "none" };
        const match = pickMatch(target, [place]);
        return match ? hint(match, match.distanceMeters) : { provider: "google", result: "none" };
      }

      const body = (await call(`${BASE}/places:searchText`, {
        method: "POST",
        headers: headers(PLACE_FIELDS.map((field) => `places.${field}`)),
        body: JSON.stringify({
          textQuery: target.name,
          languageCode: "id",
          regionCode: "ID",
          maxResultCount: 5,
          locationBias: { circle: { center: { latitude: target.location.lat, longitude: target.location.lng }, radius: BIAS_METERS } },
        }),
      })) as { places?: Place[] } | null;
      const match = pickMatch(target, (body?.places ?? []).flatMap((place) => placeOf(place) ?? []));
      ids.set(key, { at: now().getTime(), placeId: match?.id ?? null });
      return match ? hint(match, match.distanceMeters) : { provider: "google", result: "none" };
    },
  };
}
