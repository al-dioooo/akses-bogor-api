// Pengecekan titik laporan (FR-22, FR-23): kecamatan dari batas OpenStreetMap (ADR-0034) dan lokasi terbit di sekitar.
import { asc, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { districts, places } from "../db/schema.js";
import { HttpError } from "../http/errors.js";

export type Point = { lat: number; lng: number };

/** Radius pencarian lokasi yang mungkin sama (FR-23). */
export const NEARBY_METERS = 50;
/** Kemiripan trigram minimal supaya dua nama dianggap mirip. */
const NAME_SIMILARITY = 0.3;

const geometry = ({ lat, lng }: Point) => sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)`;

export const outsideKotaBogor = () =>
  new HttpError(
    422,
    "di_luar_kota_bogor",
    "Titik ini berada di luar Kota Bogor. Untuk saat ini AksesBogor hanya mencatat tempat di enam kecamatan Kota Bogor: Bogor Barat, Bogor Selatan, Bogor Tengah, Bogor Timur, Bogor Utara, dan Tanah Sareal.",
  );

/** Kecamatan yang memuat titik, atau null bila di luar Kota Bogor. Titik tepat di garis batas masuk ke slug pertama. */
export async function districtAt(db: Db, point: Point) {
  const [row] = await db
    .select({ slug: districts.slug, name: districts.name })
    .from(districts)
    .where(sql`ST_Covers(${districts.boundary}, ${geometry(point)})`)
    .orderBy(asc(districts.slug))
    .limit(1);
  return row ?? null;
}

/** Seperti `districtAt`, tetapi titik di luar Kota Bogor menjadi galat 422 dengan pesan cakupan wilayah (ADR-0010). */
export async function requireDistrict(db: Db, point: Point) {
  const district = await districtAt(db, point);
  if (!district) throw outsideKotaBogor();
  return district;
}

/**
 * Lokasi terbit dalam radius 50 m yang namanya mirip, terdekat dulu, paling banyak 5 (FR-23). Tanpa nama, semua lokasi
 * dalam radius itu dianggap mungkin sama. `excludePlaceId` dipakai saat mengedit lokasi itu sendiri.
 */
export async function nearbyPlaces(db: Db, point: Point, name?: string, excludePlaceId?: string) {
  const here = sql`${geometry(point)}::geography`;
  const distance = sql<number>`ST_Distance(${places.location}::geography, ${here})`;
  const similar = name
    ? sql`(similarity(lower(${places.name}), lower(${name})) >= ${NAME_SIMILARITY}
        OR strpos(lower(${places.name}), lower(${name})) > 0
        OR strpos(lower(${name}), lower(${places.name})) > 0)`
    : sql`true`;
  const rows = await db
    .select({ id: places.id, name: places.name, category: places.category, status: places.status, distance })
    .from(places)
    .where(
      sql`ST_DWithin(${places.location}::geography, ${here}, ${NEARBY_METERS}) AND ${similar}${excludePlaceId ? sql` AND ${places.id} <> ${excludePlaceId}` : sql``}`,
    )
    .orderBy(distance)
    .limit(5);
  return rows.map(({ distance: meters, ...row }) => ({ ...row, distanceMeters: Math.round(meters) }));
}
