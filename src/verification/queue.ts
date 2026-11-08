// Bacaan panel verifikator (FR-30, FR-37, FR-38). Laporan milik verifikator itu sendiri tidak pernah dikembalikan,
// dan pelapor hanya disebut dengan nama tampilannya.
import { and, asc, count, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { districts, photos, placeFacilities, places, reportClarifications, reports, users } from "../db/schema.js";
import type { FacilityAnswer } from "../domain/status.js";

/** Isian laporan yang disimpan `submitReport` di `reports.submission` (versi 1). */
export type Submission = {
  versi: 1;
  name: string;
  category: (typeof places.category.enumValues)[number];
  landmark: string | null;
  description: string | null;
  facilities: (FacilityAnswer & { note: string | null })[];
};

const iso = (value: Date) => new Date(value).toISOString();
const isoOrNull = (value: Date | null) => (value ? iso(value) : null);

/** Bukan laporan milik `viewerId` (FR-37). Laporan tanpa pelapor (akun dihapus) tetap boleh. */
const notOwnedBy = (viewerId: string) => or(isNull(reports.reporterId), ne(reports.reporterId, viewerId));

/**
 * Antrean terlama dulu (FR-30): `menunggu` untuk diperiksa, atau `klarifikasi` yang menunggu jawaban pelapor.
 * `worsens` menandai laporan yang membuat fasilitas Tersedia atau Tidak perlu menjadi Tidak tersedia (Panduan bagian 7).
 */
export async function listQueue(db: Db, viewerId: string, status: "menunggu" | "klarifikasi") {
  const where = and(eq(reports.status, status), notOwnedBy(viewerId));
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db
      .select({
        id: reports.id,
        kind: reports.kind,
        status: reports.status,
        placeId: reports.placeId,
        submission: reports.submission,
        districtSlug: districts.slug,
        districtName: districts.name,
        reporterName: users.displayName,
        submittedAt: reports.submittedAt,
        clarificationDueAt: reports.clarificationDueAt,
        photos: sql<number>`(SELECT count(*)::int FROM ${photos} WHERE ${photos.reportId} = ${reports.id})`,
        answered: sql<boolean>`EXISTS (SELECT 1 FROM ${reportClarifications} WHERE ${reportClarifications.reportId} = ${reports.id} AND ${reportClarifications.answeredAt} IS NOT NULL)`,
      })
      .from(reports)
      .innerJoin(districts, eq(districts.slug, reports.districtSlug))
      .innerJoin(users, eq(users.id, reports.reporterId))
      .where(where)
      .orderBy(asc(reports.submittedAt), asc(reports.id))
      .limit(100),
    db.select({ total: count() }).from(reports).where(where),
  ]);

  const placeIds = [...new Set(rows.map((r) => r.placeId).filter((id): id is string => id !== null))];
  const current = placeIds.length
    ? await db.select({ placeId: placeFacilities.placeId, facility: placeFacilities.facility, answer: placeFacilities.answer }).from(placeFacilities).where(inArray(placeFacilities.placeId, placeIds))
    : [];
  const worsens = (placeId: string | null, submission: Submission) =>
    placeId !== null &&
    submission.facilities.some(
      (f) => f.answer === "tidak_tersedia" && current.some((c) => c.placeId === placeId && c.facility === f.facility && (c.answer === "tersedia" || c.answer === "tidak_perlu")),
    );

  return {
    total,
    items: rows.map((r) => {
      const submission = r.submission as Submission;
      return {
        id: r.id,
        kind: r.kind,
        status: status,
        placeId: r.placeId,
        name: submission.name,
        category: submission.category,
        district: { slug: r.districtSlug, name: r.districtName },
        reporterName: r.reporterName,
        photos: r.photos,
        submittedAt: iso(r.submittedAt),
        answered: r.answered,
        clarificationDueAt: isoOrNull(r.clarificationDueAt),
        worsens: worsens(r.placeId, submission),
      };
    }),
  };
}

/** 12 bulan sebelum `now`, sama dengan `needsRecheck` di Detail (FR-38). */
export const recheckBefore = (now: Date) => {
  const before = new Date(now);
  before.setUTCMonth(before.getUTCMonth() - 12);
  return before;
};

/** Lokasi yang perlu dicek ulang, terlama dulu, paling banyak 100 (FR-38). */
export async function listRecheck(db: Db, now: Date) {
  const where = lt(places.lastVerifiedAt, recheckBefore(now));
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db
      .select({ id: places.id, name: places.name, category: places.category, districtSlug: districts.slug, districtName: districts.name, status: places.status, lastVerifiedAt: places.lastVerifiedAt })
      .from(places)
      .innerJoin(districts, eq(districts.slug, places.districtSlug))
      .where(where)
      .orderBy(asc(places.lastVerifiedAt), asc(places.id))
      .limit(100),
    db.select({ total: count() }).from(places).where(where),
  ]);
  return {
    total,
    items: rows.map(({ districtSlug, districtName, lastVerifiedAt, ...r }) => ({ ...r, district: { slug: districtSlug, name: districtName }, lastVerifiedAt: iso(lastVerifiedAt) })),
  };
}
