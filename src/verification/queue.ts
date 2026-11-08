// Bacaan panel verifikator (FR-30, FR-31, FR-37, FR-38). Laporan milik verifikator itu sendiri tidak pernah dikembalikan,
// dan pelapor hanya disebut dengan nama tampilannya.
import { and, asc, count, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { districts, photos, placeFacilities, places, reportClarifications, reports, users } from "../db/schema.js";
import { computeStatus, FACILITIES, type FacilityAnswer } from "../domain/status.js";
import { HttpError } from "../http/errors.js";
import { publishedPhotosOf, toPhoto, type ReadOptions } from "../places/queries.js";
import { nearbyPlaces } from "../reports/location.js";

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

/** Jawaban urut ramp, toilet, guiding block, lift; yang tidak ada dianggap Belum tahu. */
export const orderedFacilities = (items: readonly (FacilityAnswer & { note?: string | null })[]) =>
  FACILITIES.map((facility) => {
    const found = items.find((f) => f.facility === facility);
    return { facility, answer: found?.answer ?? "belum_tahu", reason: found?.reason ?? null, note: found?.note ?? null };
  });

const preview = (items: readonly FacilityAnswer[]) => {
  const { status, available, relevant, unknown } = computeStatus(items);
  return { status, available, relevant, unknown };
};

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

export const ownReport = () => new HttpError(403, "laporan_sendiri", "Anda tidak bisa memeriksa laporan Anda sendiri. Biarkan verifikator lain yang memeriksanya.");
export const reportNotFound = () => new HttpError(404, "laporan_tidak_ditemukan", "Laporan ini tidak ditemukan. Mungkin pelapornya sudah menghapus akun.");

/** Laporan lengkap untuk halaman pemeriksaan (FR-31), dengan data lokasi saat ini untuk dibandingkan. */
export async function getReview(db: Db, viewerId: string, id: string, opts: ReadOptions = {}) {
  const [row] = await db
    .select({
      id: reports.id,
      kind: reports.kind,
      status: reports.status,
      reporterId: reports.reporterId,
      reporterName: users.displayName,
      placeId: reports.placeId,
      submission: reports.submission,
      location: reports.location,
      districtSlug: districts.slug,
      districtName: districts.name,
      submittedAt: reports.submittedAt,
      decidedAt: reports.decidedAt,
      rejectionReason: reports.rejectionReason,
      reviewerNote: reports.reviewerNote,
    })
    .from(reports)
    .innerJoin(districts, eq(districts.slug, reports.districtSlug))
    .leftJoin(users, eq(users.id, reports.reporterId))
    .where(eq(reports.id, id));
  if (!row) throw reportNotFound();
  if (row.reporterId === viewerId) throw ownReport();

  const submission = row.submission as Submission;
  const point = { lat: row.location!.y, lng: row.location!.x };
  const [reportPhotos, clarifications, place, nearby] = await Promise.all([
    db
      .select({
        id: photos.id,
        tag: photos.tag,
        caption: photos.caption,
        alt: photos.altText,
        width: photos.width,
        height: photos.height,
        moderation: photos.moderation,
        blur: photos.blurRegions,
        clarificationId: photos.clarificationId,
      })
      .from(photos)
      .where(eq(photos.reportId, id))
      .orderBy(asc(photos.createdAt), asc(photos.id)),
    db
      .select({
        id: reportClarifications.id,
        question: reportClarifications.question,
        askedAt: reportClarifications.askedAt,
        dueAt: reportClarifications.dueAt,
        answer: reportClarifications.answer,
        answeredAt: reportClarifications.answeredAt,
      })
      .from(reportClarifications)
      .where(eq(reportClarifications.reportId, id))
      .orderBy(asc(reportClarifications.askedAt)),
    row.placeId ? currentPlace(db, row.placeId, opts) : null,
    nearbyPlaces(db, point, submission.name, row.placeId ?? undefined),
  ]);
  const facilities = orderedFacilities(submission.facilities);

  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    submittedAt: iso(row.submittedAt),
    decidedAt: isoOrNull(row.decidedAt),
    rejectionReason: row.rejectionReason,
    reporterName: row.reporterName,
    reviewerNote: row.reviewerNote,
    submission: {
      name: submission.name,
      category: submission.category,
      location: point,
      district: { slug: row.districtSlug, name: row.districtName },
      landmark: submission.landmark,
      description: submission.description,
      facilities,
      status: preview(facilities),
    },
    photos: reportPhotos.map(({ moderation, blur, ...p }) => ({ ...p, hidden: moderation === "disembunyikan", blur: blur ?? [] })),
    clarifications: clarifications.map((c) => ({ ...c, askedAt: iso(c.askedAt), dueAt: iso(c.dueAt), answeredAt: isoOrNull(c.answeredAt) })),
    place,
    nearby,
  };
}

async function currentPlace(db: Db, placeId: string, opts: ReadOptions) {
  const [row] = await db
    .select({
      id: places.id,
      updatedAt: places.updatedAt,
      name: places.name,
      category: places.category,
      location: places.location,
      districtSlug: districts.slug,
      districtName: districts.name,
      landmark: places.landmark,
      description: places.description,
      lastVerifiedAt: places.lastVerifiedAt,
    })
    .from(places)
    .innerJoin(districts, eq(districts.slug, places.districtSlug))
    .where(eq(places.id, placeId));
  if (!row) return null;
  const [answers, published] = await Promise.all([
    db
      .select({ facility: placeFacilities.facility, answer: placeFacilities.answer, reason: placeFacilities.reason, note: placeFacilities.note })
      .from(placeFacilities)
      .where(eq(placeFacilities.placeId, placeId)),
    publishedPhotosOf(db, [placeId]),
  ]);
  const facilities = orderedFacilities(answers);
  return {
    id: row.id,
    version: iso(row.updatedAt),
    name: row.name,
    category: row.category,
    location: { lat: row.location.y, lng: row.location.x },
    district: { slug: row.districtSlug, name: row.districtName },
    landmark: row.landmark,
    description: row.description,
    facilities,
    status: preview(facilities),
    lastVerifiedAt: iso(row.lastVerifiedAt),
    photos: published.map((p) => toPhoto(p, opts.photoBaseUrl)),
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
