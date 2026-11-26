// Klien Valhalla untuk rute pejalan kaki aksesibel (ADR-0055). Valhalla berjalan di host yang sama dengan API dan hanya
// mendengar di 127.0.0.1, dengan ubin dari ekstrak OpenStreetMap Kota Bogor. Koordinat tidak keluar dari server kami.
import type { LatLng } from "./directions.js";
import { decodePolyline } from "./polyline.js";

/** `kursi_roda`: Valhalla pedestrian dengan type wheelchair. `jalan_kaki`: pedestrian biasa (type foot). */
export type AccessibleProfile = "kursi_roda" | "jalan_kaki";
export const ACCESSIBLE_PROFILES = ["kursi_roda", "jalan_kaki"] as const;

export type RouterManeuver = {
  /** Jenis manuver Valhalla (angka enum DirectionsLeg.Maneuver.Type), mis. 1 mulai, 10 belok kanan, 4 tiba. */
  type: number;
  streetNames: string[];
  distanceMeters: number;
  durationSeconds: number;
  /** Arah setelah manuver, 0 sampai 359 derajat dari utara. */
  bearing: number | null;
  location: LatLng;
};

export type RouterEdge = {
  /** Id way OSM; 0 untuk sambungan buatan Valhalla. */
  wayId: number;
  lengthMeters: number;
  /** Jenis jalur menurut Valhalla, mis. road, footway, sidewalk, steps, elevator. */
  use: string;
};

export type RouterAnswer = {
  distanceMeters: number;
  durationSeconds: number;
  /** GeoJSON [bujur, lintang]. */
  coordinates: [number, number][];
  maneuvers: RouterManeuver[];
  /** Jalur yang dilewati, atau null bila Valhalla gagal mencocokkan garis rute dengan jalurnya. */
  edges: RouterEdge[] | null;
};

export type AccessibleRouter = (from: LatLng, to: LatLng, profile: AccessibleProfile) => Promise<RouterAnswer>;

/** Valhalla tidak menemukan jalur dengan profil ini (error_code 442), mis. semua jalan ke tujuan lewat tangga. */
export class NoPathError extends Error {}
/** Titik awal atau tujuan terlalu jauh dari jalur yang bisa dilewati (error_code 171). */
export class NoNearbyPathError extends Error {}

/**
 * Pilihan costing per profil. Kursi roda: Valhalla menolak tangga dan jalur bertag wheelchair=no, dan permukaan buruk
 * dinilai lebih mahal. Faktor di bawah 1 membuat trotoar dan jalur pejalan kaki lebih disukai daripada badan jalan.
 * `max_grade` dan `use_hills` baru berpengaruh bila ubin dibangun dengan data ketinggian.
 */
export const COSTING: Record<AccessibleProfile, Record<string, number | string>> = {
  kursi_roda: { type: "wheelchair", sidewalk_factor: 0.8, walkway_factor: 0.8, use_tracks: 0, use_hills: 0, max_grade: 8, step_penalty: 600, alley_factor: 2, driveway_factor: 5 },
  jalan_kaki: { type: "foot", sidewalk_factor: 0.9, walkway_factor: 0.9 },
};

type Maneuver = { type?: number; street_names?: string[]; length?: number; time?: number; bearing_after?: number; begin_shape_index?: number };
type RouteBody = { trip?: { summary?: { length?: number; time?: number }; legs?: { shape?: string; maneuvers?: Maneuver[] }[] }; error_code?: number };
type AttributesBody = { edges?: { way_id?: number; length?: number; use?: string }[]; error_code?: number };

/**
 * Klien Valhalla: `/route` untuk rute dan langkah, lalu `/trace_attributes` pada garis yang sama untuk id way OSM.
 * Bila pencocokan jalur gagal, rute tetap dikirim dan cakupan datanya dilaporkan tidak diketahui.
 */
export function valhallaRouter({ url, fetch = globalThis.fetch, timeoutMs = 8000 }: { url: string; fetch?: typeof globalThis.fetch; timeoutMs?: number }): AccessibleRouter {
  const base = url.replace(/\/+$/, "");
  const post = async <T>(path: string, body: unknown): Promise<{ status: number; body: (T & { error_code?: number }) | null }> => {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error("Valhalla tidak bisa dihubungi");
    }
    return { status: response.status, body: (await response.json().catch(() => null)) as (T & { error_code?: number }) | null };
  };

  return async (from, to, profile) => {
    const costing = { pedestrian: COSTING[profile] };
    const route = await post<RouteBody>("/route", {
      locations: [
        { lat: from.lat, lon: from.lng },
        { lat: to.lat, lon: to.lng },
      ],
      costing: "pedestrian",
      costing_options: costing,
      units: "kilometers",
      // Valhalla belum punya narasi bahasa Indonesia; kalimat langkah dibuat API dari jenis manuver.
      language: "en-US",
    });
    if (route.body?.error_code === 442) throw new NoPathError("Valhalla tidak menemukan jalur");
    if (route.body?.error_code === 171) throw new NoNearbyPathError("Tidak ada jalur di dekat titik");
    const trip = route.body?.trip;
    const leg = trip?.legs?.[0];
    if (route.status !== 200 || !trip || !leg?.shape) throw new Error(`Valhalla menjawab ${route.status} ${route.body?.error_code ?? ""}`.trim());
    const coordinates = decodePolyline(leg.shape);

    const attributes = await post<AttributesBody>("/trace_attributes", {
      encoded_polyline: leg.shape,
      // edge_walk kadang gagal (error 443) saat faktor costing mengubah pilihan jalur; walk_or_snap lalu memakai
      // pencocokan peta.
      shape_match: "walk_or_snap",
      costing: "pedestrian",
      costing_options: costing,
      filters: { attributes: ["edge.way_id", "edge.length", "edge.use"], action: "include" },
    });
    const edges = attributes.status === 200 ? attributes.body?.edges : undefined;

    return {
      distanceMeters: Math.round((trip.summary?.length ?? 0) * 1000),
      durationSeconds: Math.round(trip.summary?.time ?? 0),
      coordinates,
      maneuvers: (leg.maneuvers ?? []).map((m) => {
        const [lng = 0, lat = 0] = coordinates[m.begin_shape_index ?? 0] ?? [];
        return {
          type: m.type ?? 0,
          streetNames: m.street_names ?? [],
          distanceMeters: Math.round((m.length ?? 0) * 1000),
          durationSeconds: Math.round(m.time ?? 0),
          bearing: typeof m.bearing_after === "number" ? m.bearing_after : null,
          location: { lat, lng },
        };
      }),
      edges: edges ? edges.map((e) => ({ wayId: Number(e.way_id ?? 0), lengthMeters: (e.length ?? 0) * 1000, use: e.use ?? "" })) : null,
    };
  };
}
