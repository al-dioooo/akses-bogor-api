// Sisi pelapor untuk klarifikasi (FR-41, ADR-0036): membaca pertanyaan dan menjawabnya sekali dengan teks dan foto baru.
// Setelah dijawab, laporan kembali ke antrean di posisi aslinya.
import { and, asc, count, desc, eq, isNull, sql } from "drizzle-orm";
import { audit } from "../audit/log.js";
import type { Db } from "../db/client.js";
import { photos, places, reportClarifications, reportEmails, reports } from "../db/schema.js";
import { HttpError } from "../http/errors.js";
import type { ReportBody } from "./schemas.js";
import { altText } from "./submit.js";

/** Batas foto per laporan, termasuk foto dari jawaban klarifikasi (ADR-0023). */
export const MAX_REPORT_PHOTOS = 10;

const iso = (value: Date | null) => (value ? new Date(value).toISOString() : null);
const notFound = () => new HttpError(404, "laporan_tidak_ditemukan", "Laporan ini tidak ditemukan di akun Anda.");

/** Satu laporan milik akun ini dengan pertanyaan dan jawaban klarifikasinya. */
export async function getMyReport(db: Db, userId: string, id: string) {
  const [row] = await db
    .select({
      id: reports.id,
      kind: reports.kind,
      status: reports.status,
      placeId: reports.placeId,
      placeName: sql<string>`coalesce(${places.name}, ${reports.submission}->>'name')`,
      submittedAt: reports.submittedAt,
      photos: sql<number>`(SELECT count(*)::int FROM ${photos} WHERE ${photos.reportId} = ${reports.id})`,
    })
    .from(reports)
    .leftJoin(places, eq(places.id, reports.placeId))
    .where(and(eq(reports.id, id), eq(reports.reporterId, userId)));
  if (!row) throw notFound();
  const clarifications = await db
    .select({ id: reportClarifications.id, question: reportClarifications.question, askedAt: reportClarifications.askedAt, dueAt: reportClarifications.dueAt, answer: reportClarifications.answer, answeredAt: reportClarifications.answeredAt })
    .from(reportClarifications)
    .where(eq(reportClarifications.reportId, id))
    .orderBy(asc(reportClarifications.askedAt));
  return {
    ...row,
    submittedAt: iso(row.submittedAt)!,
    clarifications: clarifications.map((c) => ({ ...c, askedAt: iso(c.askedAt)!, dueAt: iso(c.dueAt)!, answeredAt: iso(c.answeredAt) })),
  };
}

export type ClarificationAnswer = { answer: string; photos: ReportBody["photos"] };

/** Menjawab pertanyaan yang terbuka: sekali per pertanyaan, sebelum tenggat, dengan total foto paling banyak 10. */
export async function answerClarification(db: Db, userId: string, id: string, input: ClarificationAnswer, now: Date) {
  return db.transaction(async (tx) => {
    const [report] = await tx.select({ status: reports.status, reporterId: reports.reporterId, submission: reports.submission }).from(reports).where(eq(reports.id, id)).for("update");
    if (!report || report.reporterId !== userId) throw notFound();
    if (report.status !== "klarifikasi") throw new HttpError(409, "tidak_menunggu_jawaban", "Laporan ini tidak sedang menunggu jawaban Anda.");
    const [open] = await tx
      .select({ id: reportClarifications.id, dueAt: reportClarifications.dueAt })
      .from(reportClarifications)
      .where(and(eq(reportClarifications.reportId, id), isNull(reportClarifications.answeredAt)))
      .orderBy(desc(reportClarifications.askedAt))
      .limit(1);
    if (!open) throw new HttpError(409, "tidak_menunggu_jawaban", "Laporan ini tidak sedang menunggu jawaban Anda.");
    if (open.dueAt <= now) throw new HttpError(409, "tenggat_lewat", "Batas waktu menjawab sudah lewat. Anda bisa mengirim laporan baru kapan saja.");

    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(photos).where(eq(photos.reportId, id));
    if (n + input.photos.length > MAX_REPORT_PHOTOS) {
      throw new HttpError(400, "foto_terlalu_banyak", `Satu laporan paling banyak ${MAX_REPORT_PHOTOS} foto. Laporan ini sudah punya ${n} foto.`);
    }
    const name = (report.submission as { name: string }).name;
    for (const photo of input.photos) {
      const attached = await tx
        .update(photos)
        .set({ reportId: id, uploaderId: null, clarificationId: open.id, tag: photo.tag, caption: photo.caption ?? null, altText: altText(photo.tag, name) })
        .where(and(eq(photos.id, photo.id), eq(photos.uploaderId, userId), isNull(photos.reportId)))
        .returning({ id: photos.id });
      if (attached.length === 0) throw new HttpError(400, "foto_tidak_ditemukan", "Sebagian foto sudah tidak tersimpan di server. Unggah ulang fotonya, lalu kirim lagi.");
    }

    await tx.update(reportClarifications).set({ answer: input.answer, answeredAt: now }).where(eq(reportClarifications.id, open.id));
    await tx.update(reports).set({ status: "menunggu", clarificationQuestion: null, clarificationDueAt: null }).where(eq(reports.id, id));
    // Email pertanyaan yang belum sempat terkirim tidak perlu dikirim lagi (ADR-0039).
    await tx.delete(reportEmails).where(and(eq(reportEmails.reportId, id), eq(reportEmails.kind, "klarifikasi")));
    await audit(tx, {
      entity: "laporan",
      entityId: id,
      actor: { userId },
      action: "klarifikasi_dijawab",
      changes: { status: { sebelum: "klarifikasi", sesudah: "menunggu" }, fotoBaru: input.photos.length },
      at: now,
    });
    return { status: "menunggu" as const };
  });
}
