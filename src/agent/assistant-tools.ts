// Alat asisten rute publik (ADR-0050) sebagai fungsi biasa. Posisi pengunjung ada di `ToolContext` dan hanya dipakai
// server untuk tempat terdekat; hasil yang dikembalikan ke model tidak pernah memuat koordinat, baik koordinat
// pengunjung maupun koordinat tempat.
import { and, eq, inArray, sql } from "drizzle-orm";
import { districts, places } from "../db/schema.js";
import type { PlaceCategory } from "../contribute/facilities.js";
import { HttpError } from "../http/errors.js";
import type { LatLng } from "../map/directions.js";
import { KOTA_BOGOR_BBOX } from "../map/search.js";
import { MAX_ROUTE_KM } from "../map/walking-route.js";
import { listPlaces, placesNamed, published, verifiedBy } from "../places/queries.js";
import type { RouteCard } from "./cards.js";
import { placeAccessibility, type ToolContext } from "./tools.js";

type PlaceStatus = (typeof places.status.enumValues)[number];
type District = { slug: string; name: string };

/** Sumber data aksesibilitas lokasi yang sudah terbit. */
export const TEAM_CHECKED_SOURCE = "Laporan kontributor yang sudah diperiksa tim verifikator AksesBogor";

/** Sumber data lokasi yang diterbitkan langsung oleh admin (ADR-0051): tanpa verifikator kedua, jadi bukan "diverifikasi". */
export const ADMIN_PUBLISHED_SOURCE = "Diterbitkan langsung oleh admin AksesBogor, tanpa pemeriksaan verifikator kedua";

/**
 * Apakah jawaban fasilitas sebuah lokasi sudah diperiksa tim, dan oleh siapa. Semua lokasi di tabel `places` sekarang
 * terbit lewat verifikasi tim (ADR-0035) atau langsung oleh admin yang memeriksanya sendiri dengan aturan bukti yang
 * sama (ADR-0051), jadi selalu benar; `verifiedBy` dan `source` membedakan keduanya. Lokasi hasil impor yang belum
 * pernah diperiksa tim harus mengembalikan salah di sini begitu kolom asalnya ada, supaya asisten menyebutnya "belum
 * diperiksa tim".
 */
export function teamCheck(by: "tim" | "admin" = "tim"): { checkedByTeam: boolean; verifiedBy: "tim" | "admin"; source: string } {
  return { checkedByTeam: true, verifiedBy: by, source: by === "admin" ? ADMIN_PUBLISHED_SOURCE : TEAM_CHECKED_SOURCE };
}

/** Jarak garis lurus untuk model: dibulatkan ke 100 m, paling kecil 100 m, supaya tidak menunjuk posisi pengunjung. */
export const roundDistance = (meters: number) => Math.max(100, Math.round(meters / 100) * 100);

/** Posisi yang dibulatkan ke 4 desimal (sekitar 11 m), seperti rute jalan kaki. */
const rounded = ({ lat, lng }: LatLng): LatLng => ({ lat: Math.round(lat * 1e4) / 1e4, lng: Math.round(lng * 1e4) / 1e4 });
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
  return { places: found.map((p) => ({ id: p.id, name: p.name, category: p.category, status: p.status, district: p.district, ...teamCheck(p.verifiedBy) })) };
}

/** place_accessibility untuk asisten: jawaban fasilitas, ditambah apakah tim sudah memeriksanya dan sumbernya. */
export async function placeAccessibilityForAssistant(ctx: ToolContext, input: { placeId: string }) {
  const place = await placeAccessibility(ctx, input);
  return { ...place, ...teamCheck(place.verifiedBy) };
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
    .select({ id: places.id, name: places.name, category: places.category, status: places.status, slug: places.districtSlug, district: districts.name, adminPublishedAt: places.adminPublishedAt, meters })
    .from(places)
    .innerJoin(districts, eq(districts.slug, places.districtSlug))
    .where(
      and(
        published,
        sql`ST_DWithin(${places.location}::geography, ${point}, ${MAX_ROUTE_KM * 1000})`,
        input.category ? eq(places.category, input.category) : undefined,
        input.status?.length ? inArray(places.status, input.status) : undefined,
      ),
    )
    .orderBy(meters)
    .limit(input.limit ?? 5);
  return {
    places: rows.map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      status: r.status,
      district: { slug: r.slug, name: r.district },
      distanceMeters: roundDistance(Number(r.meters)),
      ...teamCheck(verifiedBy(r.adminPublishedAt)),
    })),
    note: `Jarak garis lurus dari titik awal pengunjung, dibulatkan ke 100 m, paling jauh ${MAX_ROUTE_KM} km. Bukan jarak atau waktu jalan kaki.`,
  };
}

/**
 * show_route: kartu rute jalan kaki ke lokasi AksesBogor. Web menghitung rutenya sendiri dari titik awal pengunjung;
 * model hanya menerima `pesan`.
 */
export async function showRoute(ctx: ToolContext, input: { placeId: string }) {
  const place = await placeAccessibility(ctx, input);
  const kartu: RouteCard = { type: "rute", target: { kind: "aksesbogor", placeId: place.id }, name: place.name };
  return {
    pesan: `Kartu rute ditampilkan untuk ${place.name}. Aplikasi menghitung rute jalan kaki dari titik awal pengunjung dan menampilkan peringatan serta hambatan yang tercatat; Anda tidak menerima rute itu.`,
    kartu,
  };
}

