// Query baca lokasi. Semua hanya membaca lokasi yang sudah terbit dan masih tayang (tabel `places`, tanpa yang diturunkan
// admin, ADR-0051) dan foto yang lolos moderasi.
import { and, asc, count, countDistinct, eq, exists, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { districts, photos, placeFacilities, places, reports } from "../db/schema.js";
import { computeStatus } from "../domain/status.js";
import type { PlaceFilters } from "./schemas.js";

export interface ReadOptions {
  /** Alamat publik bucket foto (R2), mis. https://foto.aksesbogor.id. */
  photoBaseUrl?: string;
}

type PhotoRow = { id: string; storageKey: string; altText: string; caption: string | null; tag: (typeof photos.tag.enumValues)[number]; source: (typeof photos.source.enumValues)[number] };

export const photoUrl = (key: string, base?: string) => (base ? `${base.replace(/\/+$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}` : null);
export const toPhoto = (p: PhotoRow, base?: string) => ({ id: p.id, url: photoUrl(p.storageKey, base), alt: p.altText, caption: p.caption, tag: p.tag, source: p.source });
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Lokasi yang masih tayang. Dipakai setiap query publik; lokasi yang diturunkan admin hanya terlihat di route admin. */
export const published = isNull(places.unpublishedAt);

/** Siapa yang terakhir menerbitkan data lokasi: verifikator lewat laporan, atau admin langsung (ADR-0051). */
export const verifiedBy = (adminPublishedAt: Date | null) => (adminPublishedAt ? ("admin" as const) : ("tim" as const));

/** Bulan gambar Street View sebagai `YYYY-MM`; Street View hanya memberi bulan dan tahun (ADR-0057). */
export const imageMonth = (date: string | null) => (date ? date.slice(0, 7) : null);

function filterConditions(f: PlaceFilters, bbox?: [number, number, number, number]): SQL | undefined {
  const conditions: (SQL | undefined)[] = [
    published,
    f.q ? ilike(places.name, `%${escapeLike(f.q)}%`) : undefined,
    f.category ? inArray(places.category, f.category) : undefined,
    f.district ? inArray(places.districtSlug, f.district) : undefined,
    f.status ? inArray(places.status, f.status) : undefined,
    bbox ? sql`${places.location} && ST_MakeEnvelope(${bbox[0]}, ${bbox[1]}, ${bbox[2]}, ${bbox[3]}, 4326)` : undefined,
  ];
  // Setiap fasilitas yang dipilih harus Tersedia.
  for (const facility of f.facility ?? []) {
    conditions.push(
      exists(
        sql`(SELECT 1 FROM ${placeFacilities} WHERE ${placeFacilities.placeId} = ${places.id} AND ${placeFacilities.facility} = ${facility} AND ${placeFacilities.answer} = 'tersedia')`,
      ),
    );
  }
  return and(...conditions);
}

const summaryColumns = {
  id: places.id,
  name: places.name,
  category: places.category,
  districtSlug: places.districtSlug,
  districtName: districts.name,
  status: places.status,
  available: places.facilitiesAvailable,
  relevant: places.facilitiesRelevant,
  unknown: places.facilitiesUnknown,
  location: places.location,
  lastVerifiedAt: places.lastVerifiedAt,
  adminPublishedAt: places.adminPublishedAt,
  verificationSource: places.verificationSource,
  streetViewImageDate: places.streetViewImageDate,
};
type SummaryRow = Omit<{ [K in keyof typeof summaryColumns]: (typeof summaryColumns)[K]["_"]["data"] }, "adminPublishedAt" | "streetViewImageDate"> & {
  adminPublishedAt: Date | null;
  streetViewImageDate: string | null;
};

const toSummary = (r: SummaryRow) => ({
  id: r.id,
  name: r.name,
  category: r.category,
  district: { slug: r.districtSlug, name: r.districtName },
  status: r.status,
  summary: { available: r.available, relevant: r.relevant, unknown: r.unknown },
  location: { lat: r.location.y, lng: r.location.x },
  lastVerifiedAt: r.lastVerifiedAt.toISOString(),
  verifiedBy: verifiedBy(r.adminPublishedAt),
  verificationSource: r.verificationSource,
  streetViewImageDate: imageMonth(r.streetViewImageDate),
});

export const publishedPhotosOf = (db: Db, placeIds: string[]) =>
  db
    .select({ placeId: photos.placeId, id: photos.id, storageKey: photos.storageKey, altText: photos.altText, caption: photos.caption, tag: photos.tag, source: photos.source })
    .from(photos)
    .where(and(inArray(photos.placeId, placeIds), eq(photos.moderation, "tayang")))
    .orderBy(photos.placeId, asc(photos.tag), asc(photos.createdAt));

export async function listPlaces(db: Db, f: PlaceFilters & { limit: number; offset: number }, opts: ReadOptions = {}) {
  const where = filterConditions(f);
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db
      .select(summaryColumns)
      .from(places)
      .innerJoin(districts, eq(districts.slug, places.districtSlug))
      .where(where)
      .orderBy(sql`lower(${places.name})`, asc(places.id))
      .limit(f.limit)
      .offset(f.offset),
    db.select({ total: count() }).from(places).where(where),
  ]);
  // Satu foto sampul per lokasi: foto tayang pertama, tag pintu_masuk lebih dulu (urutan enum).
  const covers = new Map<string, PhotoRow>();
  if (rows.length) for (const p of await publishedPhotosOf(db, rows.map((r) => r.id))) if (!covers.has(p.placeId!)) covers.set(p.placeId!, p);
  return {
    total,
    limit: f.limit,
    offset: f.offset,
    items: rows.map((r) => {
      const cover = covers.get(r.id);
      return { ...toSummary(r), coverPhoto: cover ? toPhoto(cover, opts.photoBaseUrl) : null };
    }),
  };
}

export async function mapPlaces(db: Db, f: PlaceFilters & { bbox?: [number, number, number, number] }) {
  const rows = await db
    .select({ id: places.id, name: places.name, category: places.category, status: places.status, location: places.location })
    .from(places)
    .where(filterConditions(f, f.bbox))
    .orderBy(asc(places.id))
    .limit(2000);
  return {
    type: "FeatureCollection" as const,
    features: rows.map((r) => ({
      type: "Feature" as const,
      id: r.id,
      geometry: { type: "Point" as const, coordinates: [r.location.x, r.location.y] as [number, number] },
      properties: { name: r.name, category: r.category, status: r.status },
    })),
  };
}

export async function getPlace(db: Db, id: string, now: Date, opts: ReadOptions = {}) {
  const [row] = await db
    .select({ ...summaryColumns, landmark: places.landmark, description: places.description, updatedAt: places.updatedAt })
    .from(places)
    .innerJoin(districts, eq(districts.slug, places.districtSlug))
    .where(and(eq(places.id, id), published));
  if (!row) return null;
  const [facilities, placePhotos] = await Promise.all([
    db
      .select({ facility: placeFacilities.facility, answer: placeFacilities.answer, reason: placeFacilities.reason, note: placeFacilities.note })
      .from(placeFacilities)
      .where(eq(placeFacilities.placeId, id))
      .orderBy(asc(placeFacilities.facility)),
    publishedPhotosOf(db, [id]),
  ]);
  const recheckBefore = new Date(now);
  recheckBefore.setUTCMonth(recheckBefore.getUTCMonth() - 12);
  return {
    ...toSummary(row),
    landmark: row.landmark,
    description: row.description,
    facilities,
    because: computeStatus(facilities).because.map(({ facility, answer, reason }) => ({ facility, answer, reason: reason ?? null })),
    photos: placePhotos.map((p) => toPhoto(p, opts.photoBaseUrl)),
    needsRecheck: row.lastVerifiedAt < recheckBefore,
    version: row.updatedAt.toISOString(),
  };
}

export async function placeStats(db: Db) {
  const [byCategory, [stepFree], [contributors]] = await Promise.all([
    db.select({ category: places.category, n: count() }).from(places).where(published).groupBy(places.category),
    db
      .select({ n: count() })
      .from(placeFacilities)
      .innerJoin(places, eq(places.id, placeFacilities.placeId))
      .where(and(published, eq(placeFacilities.facility, "ramp"), inArray(placeFacilities.answer, ["tersedia", "tidak_perlu"]))),
    db.select({ n: countDistinct(reports.reporterId) }).from(reports).where(and(eq(reports.status, "diterbitkan"), isNotNull(reports.reporterId))),
  ]);
  const counts = { kampus: 0, masjid: 0, halte: 0, rumah_sakit: 0 };
  for (const r of byCategory) counts[r.category] = r.n;
  return {
    places: byCategory.reduce((sum, r) => sum + r.n, 0),
    byCategory: counts,
    stepFreeEntrance: stepFree?.n ?? 0,
    contributors: contributors?.n ?? 0,
  };
}

export async function listDistricts(db: Db) {
  return db
    .select({ slug: districts.slug, name: districts.name, city: districts.city, places: count(places.id) })
    .from(districts)
    .leftJoin(places, and(eq(places.districtSlug, districts.slug), published))
    .groupBy(districts.slug)
    .orderBy(asc(districts.name));
}

/**
 * Lokasi terbit yang namanya mirip kata kunci, paling mirip dulu, untuk ditampilkan sebelum hasil Mapbox di pencarian
 * formulir laporan (ADR-0032). Membantu pelapor menemukan lokasi yang sudah ada (FR-23).
 */
export async function placesNamed(db: Db, query: string, limit = 3) {
  const q = query.toLowerCase();
  const score = sql<number>`similarity(lower(${places.name}), ${q})`;
  // Setiap kata kunci ada di nama, atau namanya sangat mirip (salah ketik).
  const words = q.split(/\s+/).filter(Boolean);
  const allWords = and(...words.map((word) => sql`strpos(lower(${places.name}), ${word}) > 0`));
  const rows = await db
    .select({ id: places.id, name: places.name, category: places.category, status: places.status, districtSlug: places.districtSlug, districtName: districts.name, location: places.location, adminPublishedAt: places.adminPublishedAt })
    .from(places)
    .innerJoin(districts, eq(districts.slug, places.districtSlug))
    .where(and(published, or(allWords, sql`${score} >= 0.5`)))
    .orderBy(sql`${score} DESC`, asc(places.name))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    category: r.category,
    status: r.status,
    district: { slug: r.districtSlug, name: r.districtName },
    location: { lat: r.location.y, lng: r.location.x },
    verifiedBy: verifiedBy(r.adminPublishedAt),
  }));
}
