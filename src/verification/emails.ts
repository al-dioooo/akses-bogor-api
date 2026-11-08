// Pengiriman email status laporan dari antrean `report_emails` (ADR-0039). Alamat dan isi dibaca saat mengirim; email
// tidak dikirim bila akun pelapor sudah dihapus atau status laporan sudah berubah. Yang gagal dicoba lagi setiap jam
// selama 3 hari.
import { and, asc, eq, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { places, reportEmails, reports, users } from "../db/schema.js";
import type { Mailer } from "../email/mailer.js";
import { clarificationEmail, reportPublishedEmail, reportRejectedEmail } from "../email/report-status.js";

const HOUR_MS = 60 * 60 * 1000;
/** Email yang gagal sepanjang ini dibuang. */
export const EMAIL_RETRY_DAYS = 3;

type Log = { warn: (obj: object, msg: string) => void };

export type EmailOptions = { mailer?: Mailer; webUrl: string };

export async function sendReportEmails(db: Db, { mailer, webUrl }: EmailOptions, now: Date, { reportId, log }: { reportId?: string; log?: Log } = {}) {
  const rows = await db
    .select({
      id: reportEmails.id,
      reportId: reportEmails.reportId,
      kind: reportEmails.kind,
      attempts: reportEmails.attempts,
      createdAt: reportEmails.createdAt,
      status: reports.status,
      rejectionReason: reports.rejectionReason,
      question: reports.clarificationQuestion,
      dueAt: reports.clarificationDueAt,
      placeId: reports.placeId,
      submission: reports.submission,
      placeName: places.name,
      to: users.email,
    })
    .from(reportEmails)
    .innerJoin(reports, eq(reports.id, reportEmails.reportId))
    .leftJoin(users, eq(users.id, reports.reporterId))
    .leftJoin(places, eq(places.id, reports.placeId))
    .where(and(lte(reportEmails.nextAttemptAt, now), reportId ? eq(reportEmails.reportId, reportId) : undefined))
    .orderBy(asc(reportEmails.id))
    .limit(100);

  const result = { sent: 0, dropped: 0, failed: 0 };
  const drop = (id: number) => db.delete(reportEmails).where(eq(reportEmails.id, id));
  for (const row of rows) {
    const placeName = row.placeName ?? (row.submission as { name: string }).name;
    const message =
      !row.to
        ? null
        : row.kind === "diterbitkan" && row.status === "diterbitkan" && row.placeId
          ? reportPublishedEmail(row.to, { placeName, placeId: row.placeId, webUrl })
          : row.kind === "ditolak" && row.status === "ditolak" && row.rejectionReason
            ? reportRejectedEmail(row.to, { placeName, reason: row.rejectionReason, webUrl })
            : row.kind === "klarifikasi" && row.status === "klarifikasi" && row.question && row.dueAt
              ? clarificationEmail(row.to, { placeName, reportId: row.reportId, question: row.question, dueAt: row.dueAt, webUrl })
              : null;
    if (!message) {
      await drop(row.id);
      result.dropped += 1;
      continue;
    }
    const expired = row.createdAt.getTime() <= now.getTime() - EMAIL_RETRY_DAYS * 24 * HOUR_MS;
    try {
      if (!mailer) throw new Error("pengirim email belum diatur");
      await mailer(message);
      await drop(row.id);
      result.sent += 1;
    } catch (error) {
      result.failed += 1;
      if (expired) {
        await drop(row.id);
        log?.warn({ err: error, reportId: row.reportId, kind: row.kind }, "email status laporan dibuang setelah 3 hari gagal");
      } else {
        await db
          .update(reportEmails)
          .set({ attempts: row.attempts + 1, nextAttemptAt: new Date(now.getTime() + HOUR_MS) })
          .where(eq(reportEmails.id, row.id));
        log?.warn({ err: error, reportId: row.reportId, kind: row.kind }, "email status laporan gagal; dicoba lagi satu jam lagi");
      }
    }
  }
  return result;
}
