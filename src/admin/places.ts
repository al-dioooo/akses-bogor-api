// Bacaan untuk halaman Kelola tempat (ADR-0050). Berbeda dengan query publik, di sini tempat yang diturunkan ikut terbaca,
// dengan alasannya. Hanya dipanggil route `/admin/*` yang sudah memeriksa peran admin.
import { and, asc, count, desc, eq, ilike, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { withoutAksesBogorData } from "../contribute/facilities.js";
import type { Db } from "../db/client.js";
import { auditLog, districts, placeFacilities, places, users } from "../db/schema.js";
import { HttpError } from "../http/errors.js";
import { publishedPhotosOf, toPhoto, verifiedBy, type ReadOptions } from "../places/queries.js";
import type { AdminPlaceQuery } from "./schemas.js";

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);
const iso = (date: Date | null) => (date ? new Date(date).toISOString() : null);

export const placeNotFound = () => new HttpError(404, "lokasi_tidak_ditemukan", "Lokasi ini tidak ditemukan.");

function conditions(q: AdminPlaceQuery): SQL | undefined {
  return and(
    q.q ? ilike(places.name, `%${escapeLike(q.q)}%`) : undefined,
    q.category ? eq(places.category, q.category) : undefined,
    q.district ? eq(places.districtSlug, q.district) : undefined,
    q.status ? eq(places.status, q.status) : undefined,
    q.origin === "admin" ? isNotNull(places.adminPublishedAt) : q.origin === "tim" ? isNull(places.adminPublishedAt) : undefined,
    q.published === "ya" ? isNull(places.unpublishedAt) : q.published === "tidak" ? isNotNull(places.unpublishedAt) : undefined,
  );
}

const itemColumns = {
  id: places.id,
  name: places.name,
  category: places.category,
  districtSlug: places.districtSlug,
  districtName: districts.name,
  status: places.status,
  available: places.facilitiesAvailable,
  relevant: places.facilitiesRelevant,
  unknown: places.facilitiesUnknown,
  lastVerifiedAt: places.lastVerifiedAt,
  adminPublishedAt: places.adminPublishedAt,
  updatedAt: places.updatedAt,
  unpublishedAt: places.unpublishedAt,
  unpublishedReason: places.unpublishedReason,
};

type ItemRow = {
  id: string;
  name: string;
  category: (typeof places.category.enumValues)[number];
  districtSlug: string;
  districtName: string;
  status: (typeof places.status.enumValues)[number];
  available: number;
  relevant: number;
  unknown: number;
  lastVerifiedAt: Date;
  adminPublishedAt: Date | null;
  updatedAt: Date;
  unpublishedAt: Date | null;
  unpublishedReason: string | null;
};

const toItem = (r: ItemRow) => ({
  id: r.id,
  name: r.name,
  category: r.category,
  district: { slug: r.districtSlug, name: r.districtName },
  status: r.status,
  summary: { available: r.available, relevant: r.relevant, unknown: r.unknown },
  verifiedBy: verifiedBy(r.adminPublishedAt),
  lastVerifiedAt: iso(r.lastVerifiedAt)!,
  updatedAt: iso(r.updatedAt)!,
  published: r.unpublishedAt === null,
  unpublishedAt: iso(r.unpublishedAt),
  unpublishedReason: r.unpublishedReason,
});

/** Semua tempat, termasuk yang diturunkan, urut nama. */
export async function listAdminPlaces(db: Db, q: AdminPlaceQuery) {
  const where = conditions(q);
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db
      .select(itemColumns)
      .from(places)
      .innerJoin(districts, eq(districts.slug, places.districtSlug))
      .where(where)
      .orderBy(sql`lower(${places.name})`, asc(places.id))
      .limit(q.limit)
      .offset(q.offset),
    db.select({ total: count() }).from(places).where(where),
  ]);
  return { total, limit: q.limit, offset: q.offset, items: rows.map(toItem) };
}

/** Data lengkap satu tempat untuk formulir ubah, atau 404. */
export async function getAdminPlace(db: Db, id: string, opts: ReadOptions = {}) {
  const [row] = await db
    .select({ ...itemColumns, location: places.location, landmark: places.landmark, description: places.description, adminName: users.displayName })
    .from(places)
    .innerJoin(districts, eq(districts.slug, places.districtSlug))
    .leftJoin(users, eq(users.id, places.adminPublishedBy))
    .where(eq(places.id, id));
  if (!row) throw placeNotFound();
  const [facilities, photos] = await Promise.all([
    db
      .select({ facility: placeFacilities.facility, answer: placeFacilities.answer, reason: placeFacilities.reason, note: placeFacilities.note })
      .from(placeFacilities)
      .where(eq(placeFacilities.placeId, id))
      .orderBy(asc(placeFacilities.facility)),
    publishedPhotosOf(db, [id]),
  ]);
  return {
    ...toItem(row),
    version: iso(row.updatedAt)!,
    location: { lat: row.location.y, lng: row.location.x },
    landmark: row.landmark,
    description: row.description,
    facilities,
    photos: photos.map((p) => toPhoto(p, opts.photoBaseUrl)),
    adminPublishedBy: row.adminPublishedAt ? (row.adminName ?? null) : null,
  };
}

/** Riwayat satu tempat dari log audit (ADR-0038), terbaru dulu. Nama yang tampil hanya nama tampilan anggota tim. */
export async function placeHistory(db: Db, id: string) {
  const [exists] = await db.select({ id: places.id }).from(places).where(eq(places.id, id));
  if (!exists) throw placeNotFound();
  const rows = await db
    .select({ id: auditLog.id, action: auditLog.action, name: users.displayName, label: auditLog.actorLabel, at: auditLog.createdAt, changes: auditLog.changes })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(and(eq(auditLog.entityType, "lokasi"), eq(auditLog.entityId, id)))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(200);
  return {
    items: rows.map((r) => ({
      id: r.id,
      action: r.action,
      actor: { name: r.name ?? null, label: (r.label as "sistem" | "skrip" | null) ?? null },
      at: iso(r.at)!,
      changes: (r.changes as Record<string, unknown> | null) ?? null,
    })),
  };
}

type CandidateRow = { osm_type: string; osm_id: string | number; name: string | null; category: ItemRow["category"]; slug: string; district: string; lat: number; lng: number; wheelchair: string | null };
const rowsOf = <T>(result: unknown) => (result as { rows: T[] }).rows;

/**
 * Kandidat OpenStreetMap (ADR-0049) yang belum punya lokasi AksesBogor, untuk dibuat menjadi tempat oleh admin. Aturan
 * 50 m sama dengan lapisan Peta dan agen, jadi kandidat hilang begitu tempatnya dibuat.
 */
export async function listCandidates(db: Db, q: { q?: string; category?: ItemRow["category"]; district?: string; limit: number; offset: number }) {
  const where = sql`${withoutAksesBogorData}
      ${q.q ? sql`AND o.name ILIKE ${`%${escapeLike(q.q)}%`}` : sql``}
      ${q.category ? sql`AND o.category = ${q.category}` : sql``}
      ${q.district ? sql`AND o.district_slug = ${q.district}` : sql``}`;
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db
      .execute(sql`
        SELECT o.osm_type, o.osm_id, o.name, o.category, d.slug, d.name AS district, ST_Y(o.location) AS lat, ST_X(o.location) AS lng,
          o.tags->>'wheelchair' AS wheelchair
        FROM osm_places o JOIN districts d ON d.slug = o.district_slug
        WHERE ${where}
        ORDER BY o.name IS NULL, lower(o.name), o.osm_id
        LIMIT ${q.limit} OFFSET ${q.offset}`)
      .then((result) => rowsOf<CandidateRow>(result)),
    db.execute(sql`SELECT count(*)::int AS total FROM osm_places o WHERE ${where}`).then((result) => rowsOf<{ total: number }>(result)),
  ]);
  return {
    total,
    limit: q.limit,
    offset: q.offset,
    items: rows.map((r) => ({
      osmType: r.osm_type,
      osmId: Number(r.osm_id),
      name: r.name,
      category: r.category,
      district: { slug: r.slug, name: r.district },
      location: { lat: Number(r.lat), lng: Number(r.lng) },
      wheelchair: r.wheelchair,
    })),
    attribution: "© kontributor OpenStreetMap",
  };
}
