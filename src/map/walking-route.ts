// Rute jalan kaki dan hambatan di dekatnya untuk halaman agen rute (ADR-0042). Keduanya dipanggil dari browser pengguna
// sendiri dan hasilnya hanya ditampilkan kepadanya. Model tidak pernah menerima posisi pengguna, hasil Mapbox
// Directions, garis rute, atau hambatan yang dicari dari garis rute (Product Terms Mapbox §1.5).
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { osmFeatureKind } from "../db/schema.js";
import { HttpError } from "../http/errors.js";
import { OSM_ATTRIBUTION } from "../knowledge/osm.js";
import { getOsmPlace } from "../contribute/facilities.js";
import { getPlace } from "../places/queries.js";
import { DirectionsQuotaError, NoRouteError, type LatLng, type WalkingRouter } from "./directions.js";
import { decodePolyline, encodePolyline } from "./polyline.js";
import { KOTA_BOGOR_BBOX } from "./search.js";

export type RouteContext = {
  db: Db;
  now: () => Date;
  /** Kosong bila `MAPBOX_SECRET_TOKEN` belum diatur. */
  walking?: WalkingRouter;
};

/** Kalimat yang selalu ikut rute: profil jalan kaki Mapbox tidak memperhitungkan kebutuhan kursi roda. */
export const ROUTE_WARNING =
  "Rute ini rute jalan kaki dari Mapbox. Rute ini tidak memperhitungkan tangga, trotoar, kerb, atau kemiringan jalan, jadi belum tentu bisa dilewati kursi roda.";
export const MAPBOX_ATTRIBUTION = "© Mapbox © OpenStreetMap";
/** Jarak garis lurus paling jauh dari posisi pengguna ke tujuan. */
export const MAX_ROUTE_KM = 10;
export const DEFAULT_BUFFER_METERS = 20;
export const MAX_OBSTACLES = 50;
const MAX_ROUTE_POINTS = 5000;

const insideBbox = ({ lat, lng }: LatLng) => lng >= KOTA_BOGOR_BBOX[0] && lng <= KOTA_BOGOR_BBOX[2] && lat >= KOTA_BOGOR_BBOX[1] && lat <= KOTA_BOGOR_BBOX[3];
const rowsOf = <T>(result: unknown) => (result as { rows: T[] }).rows;

/** Jarak garis lurus dalam kilometer (haversine). */
function kilometers(a: LatLng, b: LatLng) {
  const rad = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/**
 * Rute jalan kaki dari posisi pengguna ke pin lokasi. Posisi dibulatkan ke 4 desimal (sekitar 11 m) sebelum dikirim ke
 * Mapbox. Jawaban Mapbox tidak disimpan.
 */
export async function walkingRoute(ctx: RouteContext, input: RouteInput) {
  if (!ctx.walking) throw new HttpError(503, "rute_belum_diatur", "Rute jalan kaki belum diatur di server.");
  const { from, place } = await routeEnds(ctx, input);
  let route;
  try {
    route = await ctx.walking(from, place.location);
  } catch (error) {
    if (error instanceof DirectionsQuotaError) throw new HttpError(503, "rute_penuh", "Rute jalan kaki sudah mencapai batas hari ini. Coba lagi besok.");
    if (error instanceof NoRouteError) throw new HttpError(422, "rute_tidak_ditemukan", "Rute jalan kaki ke tempat ini tidak ditemukan.");
    throw new HttpError(502, "rute_gagal", "Rute jalan kaki sedang tidak bisa dimuat. Coba lagi sebentar lagi.");
  }
  return {
    destination: { placeId: place.placeId, osm: place.osm, name: place.name, location: place.location },
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds,
    steps: route.steps,
    geometry: route.geometry,
    polyline: encodePolyline(route.geometry.coordinates),
    warning: ROUTE_WARNING,
    attribution: MAPBOX_ATTRIBUTION,
  };
}

type Destination = { placeId: string | null; osm: { type: string; id: number } | null; name: string | null; location: LatLng };
export type RouteInput = { from: LatLng; placeId?: string; osm?: { type: string; id: number } };

/**
 * Titik awal dan tujuan sebuah rute: posisi pengguna dibulatkan ke 4 desimal (sekitar 11 m), harus di dalam Kota Bogor
 * dan paling jauh `MAX_ROUTE_KM` dari pin tujuan. Dipakai rute Mapbox dan rute OpenStreetMap (ADR-0055).
 */
export async function routeEnds(ctx: Pick<RouteContext, "db" | "now">, input: RouteInput): Promise<{ from: LatLng; place: Destination }> {
  const place = await destinationOf(ctx, input);
  if (!place) throw new HttpError(404, "lokasi_tidak_ditemukan", "Lokasi tidak ditemukan.");
  const from = { lat: Math.round(input.from.lat * 1e4) / 1e4, lng: Math.round(input.from.lng * 1e4) / 1e4 };
  if (!insideBbox(from)) throw new HttpError(422, "di_luar_kota_bogor", "Posisi Anda berada di luar Kota Bogor. Rute hanya tersedia dari dalam Kota Bogor.");
  if (kilometers(from, place.location) > MAX_ROUTE_KM) {
    throw new HttpError(422, "terlalu_jauh", `Tujuan lebih dari ${MAX_ROUTE_KM} km dari posisi Anda. Rute jalan kaki hanya untuk jarak yang lebih dekat.`);
  }
  return { from, place };
}

/** Tujuan rute: lokasi AksesBogor, atau tempat OpenStreetMap tanpa data AksesBogor untuk kontributor (ADR-0043). */
async function destinationOf(ctx: Pick<RouteContext, "db" | "now">, input: { placeId?: string; osm?: { type: string; id: number } }): Promise<Destination | null> {
  if (input.placeId) {
    const place = await getPlace(ctx.db, input.placeId, ctx.now());
    return place ? { placeId: place.id, osm: null, name: place.name, location: place.location } : null;
  }
  if (!input.osm) return null;
  const place = await getOsmPlace(ctx.db, { osmType: input.osm.type, osmId: input.osm.id });
  return place ? { placeId: null, osm: { type: input.osm.type, id: input.osm.id }, name: place.name, location: place.location } : null;
}

const WHEELCHAIR: Record<string, string> = { yes: "bisa untuk kursi roda", limited: "terbatas untuk kursi roda", no: "tidak bisa untuk kursi roda" };
const KERB: Record<string, string> = { raised: "Kerb tinggi", lowered: "Kerb diturunkan", flush: "Kerb rata dengan jalan", rolled: "Kerb miring", no: "Tanpa kerb" };

/** Uraian singkat fitur OSM dari tagnya, mis. "Tangga, 12 anak tangga, ada pegangan, tanpa ramp". */
export function describeFeature(kind: string, tags: Record<string, string>): string {
  const parts: string[] = [];
  if (kind === "tangga") {
    parts.push("Tangga");
    if (tags.step_count) parts.push(`${tags.step_count} anak tangga`);
    if (tags.handrail === "yes" || tags["handrail:left"] === "yes" || tags["handrail:right"] === "yes") parts.push("ada pegangan");
    if (tags.ramp === "yes" || tags["ramp:wheelchair"] === "yes") parts.push("ada ramp");
    if (tags.ramp === "no" || tags["ramp:wheelchair"] === "no") parts.push("tanpa ramp");
  } else if (kind === "kerb") {
    parts.push(KERB[tags.kerb ?? ""] ?? `Kerb (${tags.kerb ?? "jenis tidak dicatat"})`);
    if (tags["kerb:height"]) parts.push(`tinggi ${tags["kerb:height"]}`);
  } else if (kind === "guiding_block") {
    parts.push(tags.tactile_paving === "no" ? "Tanpa guiding block di titik ini" : "Guiding block (ubin pemandu)");
  } else if (kind === "lift") {
    parts.push("Lift");
  } else if (kind === "ramp") {
    parts.push(tags.ramp === "no" || tags["ramp:wheelchair"] === "no" ? "Tanpa ramp" : "Ramp");
  } else if (kind === "pintu_masuk") {
    parts.push(tags.entrance === "main" ? "Pintu masuk utama" : "Pintu masuk");
    if (tags.automatic_door && tags.automatic_door !== "no") parts.push("pintu otomatis");
    if (tags.width) parts.push(`lebar ${tags.width}`);
    if (tags.step_count && tags.step_count !== "0") parts.push(`${tags.step_count} anak tangga`);
  } else {
    parts.push(kind);
  }
  if (tags.wheelchair && WHEELCHAIR[tags.wheelchair]) parts.push(WHEELCHAIR[tags.wheelchair]!);
  if (kind === "kerb" && tags.tactile_paving === "yes") parts.push("ada guiding block");
  return parts.join(", ");
}

type ObstacleRow = { osm_type: string; osm_id: number | string; kind: (typeof osmFeatureKind.enumValues)[number]; name: string | null; tags: Record<string, string>; distance: number; along: number };

/**
 * Fitur OSM di dekat garis rute (tangga, kerb, ramp, lift, pintu masuk, guiding block), urut dari awal rute. Hanya yang
 * tercatat di OSM; daftar kosong bukan berarti jalannya bebas hambatan.
 */
export async function routeObstacles(ctx: Pick<RouteContext, "db">, input: { polyline: string; bufferMeters?: number }) {
  let coordinates: [number, number][];
  try {
    coordinates = decodePolyline(input.polyline);
  } catch {
    throw new HttpError(400, "garis_rute_tidak_valid", "Garis rute tidak bisa dibaca. Pakai nilai polyline dari rute jalan kaki.");
  }
  if (coordinates.length < 2 || coordinates.length > MAX_ROUTE_POINTS || !coordinates.every(([lng, lat]) => insideBbox({ lat, lng }))) {
    throw new HttpError(422, "garis_rute_tidak_valid", "Garis rute harus berada di Kota Bogor dan punya 2 sampai 5000 titik.");
  }
  const buffer = input.bufferMeters ?? DEFAULT_BUFFER_METERS;
  const line = JSON.stringify({ type: "LineString", coordinates });
  const rows = rowsOf<ObstacleRow>(
    await ctx.db.execute(sql`
      WITH r AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON(${line}), 4326) AS g)
      SELECT f.osm_type, f.osm_id, f.kind, f.name, f.tags,
        ST_Distance(f.geom::geography, r.g::geography) AS distance,
        ST_LineLocatePoint(r.g, ST_ClosestPoint(r.g, f.geom)) * ST_Length(r.g::geography) AS along
      FROM osm_features f, r
      WHERE f.kind IN ('tangga', 'kerb', 'ramp', 'lift', 'pintu_masuk', 'guiding_block')
        AND f.geom && ST_Expand(r.g, 0.001)
        AND ST_DWithin(f.geom::geography, r.g::geography, ${buffer})
      ORDER BY along, f.osm_type, f.osm_id
      LIMIT ${MAX_OBSTACLES + 1}`),
  );
  return {
    bufferMeters: buffer,
    truncated: rows.length > MAX_OBSTACLES,
    features: rows.slice(0, MAX_OBSTACLES).map((r) => ({
      kind: r.kind,
      description: describeFeature(r.kind, r.tags),
      name: r.name,
      tags: r.tags,
      distanceFromRouteMeters: Math.round(Number(r.distance)),
      alongRouteMeters: Math.round(Number(r.along)),
      osm: { type: r.osm_type, id: Number(r.osm_id), url: `https://www.openstreetmap.org/${r.osm_type}/${r.osm_id}` },
    })),
    note: "Data OpenStreetMap bisa tidak lengkap atau sudah berubah. Tidak adanya hambatan di daftar ini bukan berarti jalannya bebas hambatan.",
    attribution: OSM_ATTRIBUTION,
  };
}
