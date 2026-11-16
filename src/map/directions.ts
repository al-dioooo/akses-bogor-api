// Rute jalan kaki untuk agen rute (ADR-0042): Mapbox Directions profil `walking`, dipanggil dari server dengan token
// rahasia yang sama dengan pencarian tempat. Jawaban Mapbox tidak disimpan di database atau log (Product Terms Mapbox
// melarang menyimpan hasil Navigation API) dan profil ini tidak mengenal kebutuhan kursi roda.

export type LatLng = { lat: number; lng: number };

export type WalkingStep = {
  /** Petunjuk dari Mapbox dalam bahasa Indonesia, mis. "Belok kiri ke Jalan Pajajaran". */
  instruction: string;
  distanceMeters: number;
  durationSeconds: number;
  /** Nama jalan atau jalur, bila ada. */
  name: string | null;
  /** Jenis manuver Mapbox, mis. depart, turn, arrive. */
  maneuver: string;
  location: LatLng;
};

export type WalkingRoute = {
  distanceMeters: number;
  durationSeconds: number;
  steps: WalkingStep[];
  geometry: { type: "LineString"; coordinates: [number, number][] };
};

export type WalkingRouter = (from: LatLng, to: LatLng) => Promise<WalkingRoute>;

/** Batas harian bawaan untuk seluruh pengguna, supaya pemakaian tetap jauh di bawah kuota gratis bulanan Mapbox. */
export const DIRECTIONS_PER_DAY = 1000;

/** Batas harian tercapai; dihitung ulang tengah malam WIB. */
export class DirectionsQuotaError extends Error {}
/** Mapbox tidak menemukan rute jalan kaki antara kedua titik. */
export class NoRouteError extends Error {}

type Options = { token: string; now: () => Date; fetch?: typeof fetch; perDay?: number };

type Step = { distance?: number; duration?: number; name?: string; maneuver?: { type?: string; instruction?: string; location?: [number, number] } };
type Answer = { code?: string; routes?: { distance?: number; duration?: number; geometry?: { coordinates?: [number, number][] }; legs?: { steps?: Step[] }[] }[] };

const wibDate = (date: Date) => new Date(date.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);

export function mapboxWalking({ token, now, fetch = globalThis.fetch, perDay = DIRECTIONS_PER_DAY }: Options): WalkingRouter {
  let day = "";
  let used = 0;

  return async (from, to) => {
    const today = wibDate(now());
    if (today !== day) {
      day = today;
      used = 0;
    }
    if (used >= perDay) throw new DirectionsQuotaError("Batas rute harian tercapai");
    used += 1;

    const url = new URL(`https://api.mapbox.com/directions/v5/mapbox/walking/${from.lng},${from.lat};${to.lng},${to.lat}`);
    url.search = new URLSearchParams({
      access_token: token,
      alternatives: "false",
      geometries: "geojson",
      overview: "full",
      steps: "true",
      language: "id",
    }).toString();
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    } catch {
      // Galat jaringan dibuat ulang tanpa URL, karena URL-nya memuat token rahasia.
      throw new Error("Mapbox Directions tidak bisa dihubungi");
    }
    const body = (await response.json().catch(() => null)) as Answer | null;
    if (body?.code === "NoRoute" || body?.code === "NoSegment") throw new NoRouteError("Rute jalan kaki tidak ditemukan");
    const route = body?.routes?.[0];
    if (!response.ok || body?.code !== "Ok" || !route) throw new Error(`Mapbox Directions menjawab ${response.status} ${body?.code ?? ""}`.trim());
    const steps = (route.legs ?? []).flatMap((leg) => leg.steps ?? []);
    return {
      distanceMeters: Math.round(route.distance ?? 0),
      durationSeconds: Math.round(route.duration ?? 0),
      steps: steps.map((step) => {
        const [lng = 0, lat = 0] = step.maneuver?.location ?? [];
        return {
          instruction: step.maneuver?.instruction ?? "",
          distanceMeters: Math.round(step.distance ?? 0),
          durationSeconds: Math.round(step.duration ?? 0),
          name: step.name || null,
          maneuver: step.maneuver?.type ?? "",
          location: { lat, lng },
        };
      }),
      geometry: { type: "LineString", coordinates: route.geometry?.coordinates ?? [] },
    };
  };
}
