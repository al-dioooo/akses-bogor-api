// Alat asisten rute publik (ADR-0050) sebagai fungsi biasa. Selain lokasi AksesBogor, alat juga mengenal kandidat
// OpenStreetMap (ADR-0049): tempat OSM tanpa lokasi AksesBogor di dekatnya, dengan id `osm:<tipe>/<id>`, tanpa status
// dan tanpa data aksesibilitas dari tim. Tag pihak ketiga di baris OSM tidak pernah dikirim ke model. Posisi pengunjung ada di `ToolContext` dan hanya dipakai
// server untuk tempat terdekat; hasil yang dikembalikan ke model tidak pernah memuat koordinat, baik koordinat
// pengunjung maupun koordinat tempat.
import { and, eq, inArray, sql } from "drizzle-orm";
import { getOsmPlace, withoutAksesBogorData, type OsmTarget } from "../contribute/facilities.js";
import { districts, places } from "../db/schema.js";
import { OSM_LICENSE } from "../knowledge/osm.js";
import type { PlaceCategory } from "../contribute/facilities.js";
import { HttpError } from "../http/errors.js";
import type { LatLng } from "../map/directions.js";
import { KOTA_BOGOR_BBOX } from "../map/search.js";
import { MAX_ROUTE_KM } from "../map/walking-route.js";
import { listPlaces, placesNamed } from "../places/queries.js";
import type { RouteCard } from "./cards.js";
import { placeAccessibility, type ToolContext } from "./tools.js";

type PlaceStatus = (typeof places.status.enumValues)[number];
type District = { slug: string; name: string };

/** Sumber data aksesibilitas lokasi yang sudah terbit. */
export const TEAM_CHECKED_SOURCE = "Laporan kontributor yang sudah diperiksa tim verifikator AksesBogor";

/**
 * Apakah jawaban fasilitas sebuah lokasi sudah diperiksa tim. Semua lokasi di tabel `places` sekarang terbit lewat
 * verifikasi tim (ADR-0035), jadi selalu benar. Lokasi hasil impor yang belum pernah diperiksa tim harus mengembalikan
 * salah di sini begitu kolom asalnya ada, supaya asisten menyebutnya "belum diperiksa tim".
 */
export function teamCheck(): { checkedByTeam: boolean; source: string } {
  return { checkedByTeam: true, source: TEAM_CHECKED_SOURCE };
}

/** Sumber kandidat OpenStreetMap untuk model. */
export const CANDIDATE_SOURCE = `Tempat dari OpenStreetMap (© kontributor OpenStreetMap, ${OSM_LICENSE}) yang belum punya data aksesibilitas dari tim AksesBogor`;
/** Catatan untuk model setiap kali kandidat muncul. */
export const CANDIDATE_NOTE =
  'Kandidat OpenStreetMap: belum ada data aksesibilitas dari tim AksesBogor. Sampaikan hal itu, sebut "© kontributor OpenStreetMap", dan sarankan "Laporkan tempat ini" di kartu rute.';

const CANDIDATE_ID = /^osm:(node|way|relation)\/(\d{1,15})$/;
export const candidateId = (target: OsmTarget) => `osm:${target.osmType}/${target.osmId}`;
/** Pengenal kandidat `osm:way/123` menjadi tipe dan id OSM, atau null bila bukan id kandidat. */
export function parseCandidateId(id: string): OsmTarget | null {
  const match = CANDIDATE_ID.exec(id);
  return match ? { osmType: match[1]!, osmId: Number(match[2]) } : null;
}

type CandidateRow = { osm_type: string; osm_id: number | string; name: string | null; category: PlaceCategory; slug: string; district: string; meters?: number };
const toCandidate = (r: CandidateRow) => ({
  id: candidateId({ osmType: r.osm_type, osmId: Number(r.osm_id) }),
  kind: "kandidat" as const,
  name: r.name,
  category: r.category,
  district: { slug: r.slug, name: r.district },
  checkedByTeam: false,
  source: CANDIDATE_SOURCE,
});

/** Jarak garis lurus untuk model: dibulatkan ke 100 m, paling kecil 100 m, supaya tidak menunjuk posisi pengunjung. */
export const roundDistance = (meters: number) => Math.max(100, Math.round(meters / 100) * 100);

/** Posisi yang dibulatkan ke 4 desimal (sekitar 11 m), seperti rute jalan kaki. */
const rounded = ({ lat, lng }: LatLng): LatLng => ({ lat: Math.round(lat * 1e4) / 1e4, lng: Math.round(lng * 1e4) / 1e4 });
const rowsOf = <T>(result: unknown) => (result as { rows: T[] }).rows;
const insideKotaBogor = ({ lat, lng }: LatLng) => lng >= KOTA_BOGOR_BBOX[0] && lng <= KOTA_BOGOR_BBOX[2] && lat >= KOTA_BOGOR_BBOX[1] && lat <= KOTA_BOGOR_BBOX[3];

export type FindInput = { query?: string; category?: PlaceCategory; kecamatan?: string };

/** find_place untuk asisten: menurut nama, kategori, atau kecamatan, paling banyak 5, tanpa koordinat. */
export async function findPlaceForAssistant(ctx: ToolContext, input: FindInput) {
  const matches = (p: { category: PlaceCategory; district: District }) =>
    (!input.category || p.category === input.category) && (!input.kecamatan || p.district.slug === input.kecamatan);
  const found = input.query
    ? (await placesNamed(ctx.db, input.query, 20)).filter(matches).slice(0, 5)
    : (
        await listPlaces(ctx.db, {
          category: input.category ? [input.category] : undefined,
          district: input.kecamatan ? [input.kecamatan] : undefined,
          limit: 5,
          offset: 0,
        })
      ).items;
  const candidates = await findCandidates(ctx, input);
  return {
    places: [...found.map((p) => ({ id: p.id, kind: "lokasi" as const, name: p.name, category: p.category, status: p.status, district: p.district, ...teamCheck() })), ...candidates],
    ...(candidates.length > 0 ? { catatan: CANDIDATE_NOTE } : {}),
  };
}

/** Kandidat OSM menurut nama (semua kata, atau mirip), kategori, atau kecamatan, paling banyak 5. */
async function findCandidates(ctx: ToolContext, input: FindInput) {
  const q = input.query?.toLowerCase();
  const words = q?.split(/\s+/).filter(Boolean) ?? [];
  const named = q
    ? sql`AND o.name IS NOT NULL AND ((${sql.join(words.map((w) => sql`strpos(lower(o.name), ${w}) > 0`), sql` AND `)}) OR similarity(lower(o.name), ${q}) >= 0.4)`
    : sql``;
  const rows = rowsOf<CandidateRow>(
    await ctx.db.execute(sql`
      SELECT o.osm_type, o.osm_id, o.name, o.category, d.slug, d.name AS district
      FROM osm_places o JOIN districts d ON d.slug = o.district_slug
      WHERE ${withoutAksesBogorData} ${named}
        ${input.category ? sql`AND o.category = ${input.category}` : sql``}
        ${input.kecamatan ? sql`AND o.district_slug = ${input.kecamatan}` : sql``}
      ORDER BY ${q ? sql`similarity(lower(o.name), ${q}) DESC,` : sql``} o.name IS NULL, o.name, o.osm_id
      LIMIT 5`),
  );
  return rows.map(toCandidate);
}

/** place_accessibility untuk asisten: jawaban fasilitas, ditambah apakah tim sudah memeriksanya dan sumbernya. */
export async function placeAccessibilityForAssistant(ctx: ToolContext, input: { placeId: string }) {
  const osm = parseCandidateId(input.placeId);
  if (!osm) return { ...(await placeAccessibility(ctx, input)), kind: "lokasi" as const, ...teamCheck() };
  const candidate = await getOsmPlace(ctx.db, osm);
  if (!candidate) throw new HttpError(404, "lokasi_tidak_ditemukan", "Lokasi tidak ditemukan.");
  return {
    id: input.placeId,
    kind: "kandidat" as const,
    name: candidate.name,
    category: candidate.category,
    district: candidate.district,
    checkedByTeam: false,
    source: CANDIDATE_SOURCE,
    facilities: [],
    catatan: CANDIDATE_NOTE,
  };
}

export type NearbyInput = { category?: PlaceCategory; status?: PlaceStatus[]; limit?: number };

/**
 * nearby_places: lokasi AksesBogor terdekat dari posisi pengunjung, paling jauh 10 km, dengan jarak garis lurus dari
 * PostGIS yang dibulatkan. Posisi tidak ikut hasil dan tidak disimpan.
 */
export async function nearbyPlaces(ctx: ToolContext, input: NearbyInput) {
  if (!ctx.position) {
    throw new HttpError(
      422,
      "posisi_belum_ada",
      "Pengunjung belum memilih titik awal. Minta pengunjung memakai tombol lokasi atau memilih titik di peta di halaman ini, lalu bertanya lagi.",
    );
  }
  const from = rounded(ctx.position);
  if (!insideKotaBogor(from)) throw new HttpError(422, "di_luar_kota_bogor", "Titik awal pengunjung berada di luar Kota Bogor.");
  const point = sql`ST_SetSRID(ST_MakePoint(${from.lng}, ${from.lat}), 4326)::geography`;
  const meters = sql<number>`ST_Distance(${places.location}::geography, ${point})`;
  const rows = await ctx.db
    .select({ id: places.id, name: places.name, category: places.category, status: places.status, slug: places.districtSlug, district: districts.name, meters })
    .from(places)
    .innerJoin(districts, eq(districts.slug, places.districtSlug))
    .where(
      and(
        sql`ST_DWithin(${places.location}::geography, ${point}, ${MAX_ROUTE_KM * 1000})`,
        input.category ? eq(places.category, input.category) : undefined,
        input.status?.length ? inArray(places.status, input.status) : undefined,
      ),
    )
    .orderBy(meters)
    .limit(input.limit ?? 5);
  // Kandidat OSM tidak punya status, jadi tidak ikut bila status dibatasi.
  const candidates = input.status?.length
    ? []
    : rowsOf<CandidateRow>(
        await ctx.db.execute(sql`
          SELECT o.osm_type, o.osm_id, o.name, o.category, d.slug, d.name AS district, ST_Distance(o.location::geography, ${point}) AS meters
          FROM osm_places o JOIN districts d ON d.slug = o.district_slug
          WHERE ${withoutAksesBogorData} AND ST_DWithin(o.location::geography, ${point}, ${MAX_ROUTE_KM * 1000})
            ${input.category ? sql`AND o.category = ${input.category}` : sql``}
          ORDER BY meters LIMIT ${input.limit ?? 5}`),
      );
  const merged = [
    ...rows.map((r) => ({
      id: r.id,
      kind: "lokasi" as const,
      name: r.name as string | null,
      category: r.category,
      status: r.status,
      district: { slug: r.slug, name: r.district },
      distanceMeters: roundDistance(Number(r.meters)),
      ...teamCheck(),
    })).map((place, i) => [Number(rows[i]!.meters), place] as const),
    ...candidates.map((r) => [Number(r.meters), { ...toCandidate(r), distanceMeters: roundDistance(Number(r.meters)) }] as const),
  ]
    .sort((a, b) => a[0] - b[0])
    .slice(0, input.limit ?? 5)
    .map(([, place]) => place);
  return {
    places: merged,
    ...(merged.some((p) => p.kind === "kandidat") ? { catatan: CANDIDATE_NOTE } : {}),
    note: `Jarak garis lurus dari titik awal pengunjung, dibulatkan ke 100 m, paling jauh ${MAX_ROUTE_KM} km. Bukan jarak atau waktu jalan kaki.`,
  };
}

/**
 * show_route: kartu rute jalan kaki ke lokasi AksesBogor. Web menghitung rutenya sendiri dari titik awal pengunjung;
 * model hanya menerima `pesan`.
 */
export async function showRoute(ctx: ToolContext, input: { placeId: string }) {
  const osm = parseCandidateId(input.placeId);
  if (osm) {
    const candidate = await getOsmPlace(ctx.db, osm);
    if (!candidate) throw new HttpError(404, "lokasi_tidak_ditemukan", "Lokasi tidak ditemukan.");
    const name = candidate.name ?? `${candidate.category.replace("_", " ")} tanpa nama di ${candidate.district.name}`;
    const kartu: RouteCard = { type: "rute", target: { kind: "osm", osmType: osm.osmType as "node" | "way" | "relation", osmId: osm.osmId }, name: candidate.name };
    return {
      pesan: `Kartu rute ditampilkan untuk ${name}, kandidat OpenStreetMap yang belum punya data aksesibilitas dari tim AksesBogor. Kartu itu juga menampilkan "Belum ada data" dan tautan "Laporkan tempat ini". Aplikasi menghitung rute jalan kaki dari titik awal pengunjung; Anda tidak menerima rute itu.`,
      kartu,
    };
  }
  const place = await placeAccessibility(ctx, input);
  const kartu: RouteCard = { type: "rute", target: { kind: "aksesbogor", placeId: place.id }, name: place.name };
  return {
    pesan: `Kartu rute ditampilkan untuk ${place.name}. Aplikasi menghitung rute jalan kaki dari titik awal pengunjung dan menampilkan peringatan serta hambatan yang tercatat; Anda tidak menerima rute itu.`,
    kartu,
  };
}

