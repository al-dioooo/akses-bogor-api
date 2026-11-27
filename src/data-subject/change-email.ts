// Mengganti email akun atas permintaan pemiliknya (hak memperbaiki data, UU No. 27/2022 Pasal 30). Tidak ada route untuk
// ini; tim memastikan permintaannya datang dari email lama dulu (runbook permintaan-subjek-data).
//
// Better Auth mencari akun Google lewat nomor akun Google dulu, lalu lewat email, dan hanya menautkan Google ke akun yang
// emailnya sudah terverifikasi (`requireLocalEmailVerified`). Supaya tetap sejalan:
// - tautan Google dilepas, karena dibuat untuk email lama. Masuk dengan Google untuk email lama membuat akun baru yang kosong;
// - `emailVerified` menjadi false sampai pemilik masuk dengan kode ke email baru. Setelah itu masuk dengan Google untuk
//   email baru menaut lagi seperti biasa;
// - semua sesi diakhiri dan kode masuk yang belum dipakai untuk email lama maupun baru dibuang.
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../audit/log.js";
import type { Db } from "../db/client.js";
import { accounts, sessions, users, verifications } from "../db/schema.js";
import { HttpError } from "../http/errors.js";
import { codeIdentifiers } from "./export.js";

const emailTaken = () => new HttpError(409, "email_sudah_dipakai", "Email baru sudah dipakai akun lain. Akun itu harus dihapus pemiliknya dulu.");

/** Email disimpan huruf kecil, sama seperti Better Auth. */
export function normalizeEmail(value: string) {
  const email = value.trim().toLowerCase();
  if (!z.email().max(254).safeParse(email).success) throw new HttpError(400, "email_tidak_sah", "Email baru tidak sah.");
  return email;
}

export async function changeEmail(db: Db, input: { userId: string; newEmail: string; requestId: number; handler: { id: string }; now: Date }) {
  const email = normalizeEmail(input.newEmail);
  try {
    return await db.transaction(async (tx) => {
      const [user] = await tx.select({ email: users.email }).from(users).where(eq(users.id, input.userId)).for("update");
      if (!user) throw new HttpError(404, "akun_tidak_ditemukan", "Akun ini tidak ada.");
      if (user.email === email) throw new HttpError(409, "email_sama", "Email baru sama dengan email sekarang.");
      const [other] = await tx.select({ id: users.id }).from(users).where(and(eq(sql`lower(${users.email})`, email), ne(users.id, input.userId)));
      if (other) throw emailTaken();

      await tx.update(users).set({ email, emailVerified: false, updatedAt: input.now }).where(eq(users.id, input.userId));
      const links = await tx.delete(accounts).where(eq(accounts.userId, input.userId)).returning({ id: accounts.id });
      const ended = await tx.delete(sessions).where(eq(sessions.userId, input.userId)).returning({ id: sessions.id });
      await tx.delete(verifications).where(inArray(verifications.identifier, [...codeIdentifiers(user.email), ...codeIdentifiers(email)]));
      const result = { sessions: ended.length, links: links.length };
      // Tanpa email lama maupun baru (ADR-0038).
      await audit(tx, {
        entity: "pengguna",
        entityId: input.userId,
        actor: { userId: input.handler.id },
        action: "email_diubah",
        changes: { permintaan: input.requestId, sesiDiakhiri: result.sessions, tautanDilepas: result.links },
        at: input.now,
      });
      return result;
    });
  } catch (error) {
    // Dua penggantian bersamaan ke email yang sama ditolak indeks unik `users_email_idx`.
    if ((error as { code?: string; cause?: { code?: string } }).code === "23505" || (error as { cause?: { code?: string } }).cause?.code === "23505") throw emailTaken();
    throw error;
  }
}
