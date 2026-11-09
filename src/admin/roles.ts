// Peran akun (FR-36, ADR-0035). Verifikator diberikan admin lewat route; peran admin hanya lewat skrip `pnpm peran`.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { audit, type Actor } from "../audit/log.js";
import type { Db } from "../db/client.js";
import { users, type userRole } from "../db/schema.js";
import { HttpError } from "../http/errors.js";

export type Role = (typeof userRole.enumValues)[number];

/** Verifikator dan admin boleh memeriksa dan memutuskan laporan. */
export const canVerify = (role: string | null | undefined) => role === "verifikator" || role === "admin";

const memberColumns = { id: users.id, displayName: users.displayName, email: users.email, role: users.role };
export type Member = { id: string; displayName: string; email: string; role: Role };

/** Anggota tim verifikasi (verifikator dan admin), urut nama. Hanya untuk admin. */
export function listTeam(db: Db): Promise<Member[]> {
  return db.select(memberColumns).from(users).where(inArray(users.role, ["verifikator", "admin"])).orderBy(asc(sql`lower(${users.displayName})`));
}

export const accountNotFound = () => new HttpError(404, "akun_tidak_ditemukan", "Tidak ada akun dengan email itu. Minta orangnya masuk ke AksesBogor dulu.");

/**
 * Mengganti peran akun dengan email yang tepat (tanpa membedakan huruf besar). Akun harus sudah dilengkapi (ADR-0035).
 * Perubahan dicatat di log audit; peran yang sama tidak mengubah apa pun. `keepAdmin` dipakai route admin, supaya
 * admin tidak turun menjadi verifikator lewat halaman tim.
 */
export async function setRoleByEmail(db: Db, email: string, role: Role, actor: Actor, now: Date, { keepAdmin = false } = {}) {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ ...memberColumns, privacyConsentAt: users.privacyConsentAt })
      .from(users)
      .where(eq(sql`lower(${users.email})`, email.trim().toLowerCase()))
      .for("update");
    if (!user) throw accountNotFound();
    if (!user.privacyConsentAt) throw new HttpError(409, "akun_belum_lengkap", "Akun ini belum dilengkapi. Minta pemiliknya mengisi nama tampilan dan menyetujui Kebijakan Privasi dulu.");
    const before = user.role;
    if (keepAdmin && before === "admin") return { member: { id: user.id, displayName: user.displayName, email: user.email, role: before } satisfies Member, before };
    if (before !== role) {
      await tx.update(users).set({ role, updatedAt: now }).where(eq(users.id, user.id));
      await audit(tx, { entity: "pengguna", entityId: user.id, actor, action: "peran_diubah", changes: { peran: { sebelum: before, sesudah: role } }, at: now });
    }
    return { member: { id: user.id, displayName: user.displayName, email: user.email, role } satisfies Member, before };
  });
}

/** Mencabut peran verifikator; admin hanya bisa diubah lewat skrip. */
export async function revokeVerifier(db: Db, userId: string, actor: Actor, now: Date) {
  return db.transaction(async (tx) => {
    const [user] = await tx.select({ role: users.role }).from(users).where(eq(users.id, userId)).for("update");
    if (!user || user.role === "pengguna") throw new HttpError(404, "bukan_anggota_tim", "Akun ini bukan anggota tim verifikasi.");
    if (user.role === "admin") throw new HttpError(409, "admin_lewat_skrip", "Peran admin hanya bisa diubah lewat skrip di server.");
    await tx.update(users).set({ role: "pengguna", updatedAt: now }).where(and(eq(users.id, userId), eq(users.role, "verifikator")));
    await audit(tx, { entity: "pengguna", entityId: userId, actor, action: "peran_diubah", changes: { peran: { sebelum: "verifikator", sesudah: "pengguna" } }, at: now });
  });
}
