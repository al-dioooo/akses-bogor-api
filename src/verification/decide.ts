// Keputusan verifikator yang tidak menerbitkan: minta klarifikasi dan tolak (FR-32, ADR-0036). Setiap keputusan mengunci
// baris laporan, jadi keputusan kedua pada laporan yang sama menjawab 409. Email status hanya diantrekan di transaksi
// yang sama; pengirimannya terpisah (ADR-0039).
import { eq, inArray } from "drizzle-orm";
import { audit, type Actor } from "../audit/log.js";
import type { Db } from "../db/client.js";
import { photoDeletions, photos, reportClarifications, reportEmails, reports, type rejectionReason, type reportEmailKind } from "../db/schema.js";
import { HttpError } from "../http/errors.js";
import type { PhotoStore } from "../photos/storage.js";
import { alreadyDecided, isReviewable } from "./photos.js";
import { ownReport, reportNotFound } from "./queue.js";

/** Tenggat jawaban klarifikasi (ADR-0019, ADR-0036). */
export const CLARIFICATION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type RejectionReason = (typeof rejectionReason.enumValues)[number];
/** Alasan yang boleh dipilih verifikator; R6 hanya dipakai sistem. */
export const VERIFIER_REASONS = ["di_luar_kota_bogor", "duplikat", "bukti_tidak_cukup", "bukan_fasilitas_publik", "konten_tidak_pantas"] as const satisfies readonly RejectionReason[];

/** Mengunci laporan yang masih bisa diputuskan. `viewerId` kosong untuk tindakan sistem. */
export async function lockReport(tx: Db, id: string, viewerId: string | null) {
  const [report] = await tx
    .select({ id: reports.id, kind: reports.kind, status: reports.status, reporterId: reports.reporterId, placeId: reports.placeId, submission: reports.submission, location: reports.location, reviewerNote: reports.reviewerNote })
    .from(reports)
    .where(eq(reports.id, id))
    .for("update");
  if (!report) throw reportNotFound();
  if (viewerId !== null && report.reporterId === viewerId) throw ownReport();
  if (!isReviewable(report.status)) throw alreadyDecided();
  return report;
}

/** Mengantrekan email status di transaksi keputusan; pertanyaan berikutnya mengganti antrean klarifikasi yang lama. */
export async function queueEmail(tx: Db, reportId: string, kind: (typeof reportEmailKind.enumValues)[number], now: Date) {
  await tx
    .insert(reportEmails)
    .values({ reportId, kind, createdAt: now, nextAttemptAt: now })
    .onConflictDoUpdate({ target: [reportEmails.reportId, reportEmails.kind], set: { attempts: 0, createdAt: now, nextAttemptAt: now } });
}

/** Menghapus baris foto laporan dan mengantrekan berkasnya untuk dihapus. Mengembalikan kunci berkasnya. */
export async function dropReportPhotos(tx: Db, where: { reportId: string } | { ids: string[] }) {
  const rows = await tx
    .select({ id: photos.id, storageKey: photos.storageKey })
    .from(photos)
    .where("reportId" in where ? eq(photos.reportId, where.reportId) : inArray(photos.id, where.ids.length ? where.ids : [crypto.randomUUID()]));
  if (rows.length === 0) return [];
  await tx
    .insert(photoDeletions)
    .values(rows.map(({ storageKey }) => ({ storageKey })))
    .onConflictDoNothing();
  await tx.delete(photos).where(
    inArray(
      photos.id,
      rows.map((r) => r.id),
    ),
  );
  return rows.map((r) => r.storageKey);
}

/** Mencoba langsung menghapus berkas yang sudah diantrekan; yang gagal diambil pembersihan setiap jam (ADR-0031). */
export async function removeQueuedFiles(db: Db, store: PhotoStore | undefined, keys: string[], log?: { warn: (obj: object, msg: string) => void }) {
  if (!store) return;
  for (const storageKey of keys) {
    try {
      await store.remove(storageKey);
      await db.delete(photoDeletions).where(eq(photoDeletions.storageKey, storageKey));
    } catch (error) {
      log?.warn({ err: error, storageKey }, "berkas foto gagal dihapus; dicoba lagi oleh pembersihan berkala");
    }
  }
}

/**
 * Menolak laporan dalam transaksi `tx` yang sudah mengunci laporannya. Semua foto laporan ikut dihapus (ADR-0037);
 * isian tetap ada supaya Laporan saya bisa menunjukkan alasannya (ADR-0024).
 */
export async function rejectLocked(tx: Db, report: { id: string; status: string }, reason: RejectionReason, actor: Actor, note: string | undefined, now: Date) {
  const removed = await dropReportPhotos(tx, { reportId: report.id });
  await tx
    .update(reports)
    .set({
      status: "ditolak",
      rejectionReason: reason,
      decidedAt: now,
      reviewerId: "userId" in actor ? actor.userId : null,
      ...(note !== undefined ? { reviewerNote: note } : {}),
      clarificationQuestion: null,
      clarificationDueAt: null,
    })
    .where(eq(reports.id, report.id));
  await audit(tx, {
    entity: "laporan",
    entityId: report.id,
    actor,
    action: "ditolak",
    changes: { status: { sebelum: report.status, sesudah: "ditolak" }, alasan: reason, fotoDihapus: removed.length },
    at: now,
  });
  await queueEmail(tx, report.id, "ditolak", now);
  return removed;
}

export async function rejectReport(db: Db, store: PhotoStore | undefined, viewerId: string, id: string, input: { reason: RejectionReason; note?: string }, now: Date) {
  const removed = await db.transaction(async (tx) => rejectLocked(tx, await lockReport(tx, id, viewerId), input.reason, { userId: viewerId }, input.note, now));
  await removeQueuedFiles(db, store, removed);
}

/** Meminta klarifikasi: pertanyaan baru dengan tenggat 7 × 24 jam (ADR-0036). Hanya dari status menunggu. */
export async function requestClarification(db: Db, viewerId: string, id: string, input: { question: string; note?: string }, now: Date) {
  return db.transaction(async (tx) => {
    const report = await lockReport(tx, id, viewerId);
    if (report.status !== "menunggu") throw new HttpError(409, "klarifikasi_terbuka", "Laporan ini masih menunggu jawaban pelapor atas pertanyaan sebelumnya.");
    const dueAt = new Date(now.getTime() + CLARIFICATION_DAYS * DAY_MS);
    await tx.insert(reportClarifications).values({ reportId: id, question: input.question, askedBy: viewerId, askedAt: now, dueAt });
    await tx
      .update(reports)
      .set({ status: "klarifikasi", clarificationQuestion: input.question, clarificationDueAt: dueAt, ...(input.note !== undefined ? { reviewerNote: input.note } : {}) })
      .where(eq(reports.id, id));
    await audit(tx, {
      entity: "laporan",
      entityId: id,
      actor: { userId: viewerId },
      action: "klarifikasi_diminta",
      changes: { status: { sebelum: "menunggu", sesudah: "klarifikasi" }, tenggat: dueAt.toISOString() },
      at: now,
    });
    await queueEmail(tx, id, "klarifikasi", now);
    return { status: "klarifikasi" as const, dueAt: dueAt.toISOString() };
  });
}
