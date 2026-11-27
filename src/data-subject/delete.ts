// Menghapus akun atas permintaan lewat email kontak (menarik persetujuan, Kebijakan Privasi bagian "Hak Anda"). Hasilnya
// sama dengan Hapus akun di Akun Saya (ADR-0024), ditambah entri log audit dengan nomor permintaan. Skrip tidak mengirim
// email konfirmasi; balasan dari kotak kontak yang menjadi konfirmasinya. Berkas foto yang diantrekan di
// `photo_deletions` dihapus dari R2 oleh pembersihan berkala API.
import { eq } from "drizzle-orm";
import { audit } from "../audit/log.js";
import { deleteAccount } from "../auth/delete-account.js";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { HttpError } from "../http/errors.js";

export async function deleteAccountOnRequest(db: Db, input: { userId: string; requestId: number; handler: { id: string }; now: Date }) {
  return db.transaction(async (tx) => {
    const [user] = await tx.select({ role: users.role }).from(users).where(eq(users.id, input.userId)).for("update");
    if (!user) throw new HttpError(404, "akun_tidak_ditemukan", "Akun ini tidak ada.");
    // Supaya admin tidak menghapus akun admin, termasuk akunnya sendiri, tanpa sengaja.
    if (user.role === "admin") throw new HttpError(409, "akun_admin", "Akun admin tidak dihapus dengan skrip ini. Turunkan perannya dulu dengan scripts/peran.ts.");
    await deleteAccount(tx, input.userId);
    await audit(tx, { entity: "pengguna", entityId: input.userId, actor: { userId: input.handler.id }, action: "akun_dihapus", changes: { permintaan: input.requestId }, at: input.now });
  });
}
