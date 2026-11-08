// Tugas berkala verifikasi (ADR-0036, ADR-0039): laporan yang tidak dijawab sampai tenggat klarifikasi ditolak dengan
// R6, lalu email status yang tertunda dikirim atau dicoba ulang.
// Berjalan saat server mulai lalu setiap jam, seperti pembersihan akun dan foto.
import { and, eq, lte } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { reports } from "../db/schema.js";
import type { PhotoStore } from "../photos/storage.js";
import { lockReport, rejectLocked, removeQueuedFiles } from "./decide.js";
import { sendReportEmails, type EmailOptions } from "./emails.js";

const HOUR_MS = 60 * 60 * 1000;

type Log = { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };

/** Menolak laporan klarifikasi yang tenggatnya sudah lewat, satu transaksi per laporan. Mengembalikan jumlahnya. */
export async function expireClarifications(db: Db, store: PhotoStore | undefined, now: Date, log?: Log) {
  const due = await db
    .select({ id: reports.id })
    .from(reports)
    .where(and(eq(reports.status, "klarifikasi"), lte(reports.clarificationDueAt, now)));
  let expired = 0;
  for (const { id } of due) {
    const removed = await db.transaction(async (tx) => {
      const report = await lockReport(tx, id, null).catch(() => null);
      // Laporan bisa sudah dijawab atau diputuskan di antara pemilihan dan penguncian.
      if (!report || report.status !== "klarifikasi") return null;
      const [row] = await tx.select({ dueAt: reports.clarificationDueAt }).from(reports).where(eq(reports.id, id));
      if (!row?.dueAt || row.dueAt > now) return null;
      return rejectLocked(tx, report, "tidak_ada_klarifikasi", { label: "sistem" }, undefined, now);
    });
    if (removed) {
      expired += 1;
      await removeQueuedFiles(db, store, removed, log);
    }
  }
  return expired;
}

/** Menjalankan tugas berkala saat server mulai lalu setiap jam. Mengembalikan fungsi untuk menghentikannya. */
export function scheduleVerificationJobs(db: Db, store: PhotoStore | undefined, email: EmailOptions, now: () => Date, log: Log) {
  const run = async () => {
    try {
      const expired = await expireClarifications(db, store, now(), log);
      if (expired > 0) log.info({ expired }, "laporan ditolak karena klarifikasi tidak dijawab");
      const emails = await sendReportEmails(db, email, now(), { log });
      if (emails.sent + emails.failed + emails.dropped > 0) log.info(emails, "email status laporan");
    } catch (error) {
      log.warn({ err: error }, "tugas berkala verifikasi gagal");
    }
  };
  void run();
  const timer = setInterval(() => void run(), HOUR_MS);
  timer.unref();
  return () => clearInterval(timer);
}
