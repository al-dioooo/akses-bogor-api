// Mematikan atau menyalakan email status laporan (terbit, ditolak, klarifikasi) untuk satu akun, atas permintaan
// pembatasan pemrosesan (UU No. 27/2022 Pasal 41). Kode masuk dan konfirmasi hapus akun tetap dikirim karena diminta
// pemilik akun sendiri. Saat dimatikan, email yang masih antre ikut dibuang; pengirim juga melewati akun ini (ADR-0039).
import { eq, inArray } from "drizzle-orm";
import { audit } from "../audit/log.js";
import type { Db } from "../db/client.js";
import { reportEmails, reports, users } from "../db/schema.js";
import { HttpError } from "../http/errors.js";

export async function setReportEmails(db: Db, input: { userId: string; enabled: boolean; requestId: number; handler: { id: string }; now: Date }) {
  return db.transaction(async (tx) => {
    const [user] = await tx.select({ offAt: users.reportEmailsOffAt }).from(users).where(eq(users.id, input.userId)).for("update");
    if (!user) throw new HttpError(404, "akun_tidak_ditemukan", "Akun ini tidak ada.");
    if (input.enabled === (user.offAt === null)) return { changed: false, dropped: 0 };

    await tx.update(users).set({ reportEmailsOffAt: input.enabled ? null : input.now }).where(eq(users.id, input.userId));
    const dropped = input.enabled
      ? []
      : await tx
          .delete(reportEmails)
          .where(inArray(reportEmails.reportId, tx.select({ id: reports.id }).from(reports).where(eq(reports.reporterId, input.userId))))
          .returning({ id: reportEmails.id });
    await audit(tx, {
      entity: "pengguna",
      entityId: input.userId,
      actor: { userId: input.handler.id },
      action: input.enabled ? "email_laporan_dinyalakan" : "email_laporan_dimatikan",
      changes: { permintaan: input.requestId, ...(input.enabled ? {} : { antreanDibuang: dropped.length }) },
      at: input.now,
    });
    return { changed: true, dropped: dropped.length };
  });
}
