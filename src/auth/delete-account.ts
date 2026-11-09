import { and, eq, inArray, ne, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { photoDeletions, photos, reports, users, verifications } from "../db/schema.js";

/**
 * Menghapus akun beserta data pribadinya dalam satu transaksi (FR-13, ADR-0024):
 * - laporan yang belum terbit (menunggu, klarifikasi, ditolak) beserta fotonya;
 * - foto dari laporan terbit yang tidak lolos moderasi;
 * - foto yang sudah diunggah tetapi belum dipasang ke laporan (ADR-0031);
 * - akun, semua sesi, tautan Google, dan kode email yang tersisa.
 *
 * Laporan terbit dan fotonya yang tayang tetap ada; `reporter_id`, `reviewer_id`, penanya klarifikasi, dan pengubah di
 * log audit menjadi kosong lewat `ON DELETE SET NULL`. Klarifikasi dan antrean email laporan yang dihapus ikut terhapus
 * lewat `ON DELETE CASCADE`, termasuk foto dari jawaban klarifikasi. Berkas foto yang dihapus dicatat di
 * `photo_deletions` untuk dihapus dari R2.
 *
 * Mengembalikan email akun supaya email konfirmasi bisa dikirim, atau null bila akunnya sudah tidak ada.
 */
export async function deleteAccount(db: Db, userId: string): Promise<{ email: string } | null> {
  return db.transaction(async (tx) => {
    const [user] = await tx.select({ email: users.email }).from(users).where(eq(users.id, userId));
    if (!user) return null;

    const removedPhotos = await tx
      .select({ id: photos.id, storageKey: photos.storageKey })
      .from(photos)
      .innerJoin(reports, eq(photos.reportId, reports.id))
      .where(and(eq(reports.reporterId, userId), or(ne(reports.status, "diterbitkan"), ne(photos.moderation, "tayang"))));
    removedPhotos.push(...(await tx.select({ id: photos.id, storageKey: photos.storageKey }).from(photos).where(eq(photos.uploaderId, userId))));
    if (removedPhotos.length > 0) {
      await tx
        .insert(photoDeletions)
        .values(removedPhotos.map(({ storageKey }) => ({ storageKey })))
        .onConflictDoNothing();
      await tx.delete(photos).where(
        inArray(
          photos.id,
          removedPhotos.map(({ id }) => id),
        ),
      );
    }

    await tx.delete(reports).where(and(eq(reports.reporterId, userId), ne(reports.status, "diterbitkan")));
    await tx.delete(verifications).where(eq(verifications.identifier, `sign-in-otp-${user.email}`));
    await tx.delete(users).where(eq(users.id, userId));
    return { email: user.email };
  });
}
