import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { setRoleByEmail } from "../src/admin/roles.js";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import type { Db } from "../src/db/client.js";
import { auditLog, users } from "../src/db/schema.js";
import type { Email, Mailer } from "../src/email/mailer.js";
import { accounts } from "./helpers/accounts.js";
import { createTestDb } from "./helpers/db.js";

const env = loadEnv({ NODE_ENV: "test", DATABASE_URL: "postgresql://test@localhost/test", BETTER_AUTH_SECRET: "rahasia-tes-yang-panjangnya-lebih-dari-32-karakter" });
const NOW = new Date("2026-11-08T10:00:00.000Z");

let db: Db;
let close: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let helpers: ReturnType<typeof accounts>;
const sent: Email[] = [];
const mailer: Mailer = async (email) => {
  sent.push(email);
};
let admin: { token: string; user: { id: string } };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  app = await buildApp(env, { db, mailer, now: () => NOW });
  await app.ready();
  helpers = accounts(app, sent);
  admin = await helpers.reporter("admin@contoh.id", "Admin Satu");
  await setRoleByEmail(db, "admin@contoh.id", "admin", { label: "skrip" }, NOW);
}, 60_000);

afterAll(async () => {
  await app.close();
  await close();
});

const as = (token: string) => ({ authorization: `Bearer ${token}` });
const roleOf = async (id: string) => (await db.select({ role: users.role }).from(users).where(eq(users.id, id)))[0]!.role;

describe("pnpm peran (setRoleByEmail)", () => {
  it("creates the first admin and records the script as the actor", async () => {
    expect(await roleOf(admin.user.id)).toBe("admin");
    const [entry] = await db.select().from(auditLog).where(and(eq(auditLog.entityId, admin.user.id), eq(auditLog.action, "peran_diubah")));
    expect(entry).toMatchObject({ entityType: "pengguna", actorId: null, actorLabel: "skrip", changes: { peran: { sebelum: "pengguna", sesudah: "admin" } } });
  });

  it("refuses unknown and incomplete accounts", async () => {
    await expect(setRoleByEmail(db, "tidak-ada@contoh.id", "admin", { label: "skrip" }, NOW)).rejects.toMatchObject({ code: "akun_tidak_ditemukan" });
    await helpers.signIn("baru@contoh.id");
    await expect(setRoleByEmail(db, "baru@contoh.id", "admin", { label: "skrip" }, NOW)).rejects.toMatchObject({ code: "akun_belum_lengkap" });
  });
});

describe("/admin/team (FR-36)", () => {
  it("is closed to signed-out users, reporters, and verifiers", async () => {
    expect((await app.inject({ method: "GET", url: "/admin/team" })).statusCode).toBe(401);
    const reporter = await helpers.reporter("pelapor@contoh.id");
    const res = await app.inject({ method: "POST", url: "/admin/team", headers: as(reporter.token), payload: { email: "pelapor@contoh.id" } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ galat: "bukan_verifikator" });
    expect(await roleOf(reporter.user.id)).toBe("pengguna");

    const verifier = await helpers.reporter("verifikator-lain@contoh.id");
    await db.update(users).set({ role: "verifikator" }).where(eq(users.id, verifier.user.id));
    const asVerifier = await app.inject({ method: "POST", url: "/admin/team", headers: as(verifier.token), payload: { email: "pelapor@contoh.id" } });
    expect(asVerifier.statusCode).toBe(403);
    expect(asVerifier.json()).toMatchObject({ galat: "bukan_admin" });
    expect(await roleOf(reporter.user.id)).toBe("pengguna");
  });

  it("lets an admin make a verifier by exact email and lists the team", async () => {
    const member = await helpers.reporter("relawan@contoh.id", "Relawan");
    const res = await app.inject({ method: "POST", url: "/admin/team", headers: as(admin.token), payload: { email: "Relawan@Contoh.id" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: member.user.id, displayName: "Relawan", email: "relawan@contoh.id", role: "verifikator" });
    const [entry] = await db.select().from(auditLog).where(and(eq(auditLog.entityId, member.user.id), eq(auditLog.action, "peran_diubah")));
    expect(entry).toMatchObject({ actorId: admin.user.id, actorLabel: null, changes: { peran: { sebelum: "pengguna", sesudah: "verifikator" } } });

    const team = await app.inject({ method: "GET", url: "/admin/team", headers: as(admin.token) });
    const emails = (team.json() as { items: { email: string; role: string }[] }).items.map((m) => m.email);
    expect(emails).toContain("relawan@contoh.id");
    expect(emails).toContain("admin@contoh.id");
    expect(emails).not.toContain("pelapor@contoh.id");
  });

  it("answers 404 and 409 for accounts it cannot promote, and keeps admins as admins", async () => {
    const unknown = await app.inject({ method: "POST", url: "/admin/team", headers: as(admin.token), payload: { email: "tidak-ada@contoh.id" } });
    expect([unknown.statusCode, unknown.json().galat]).toEqual([404, "akun_tidak_ditemukan"]);
    await helpers.signIn("setengah@contoh.id");
    const incomplete = await app.inject({ method: "POST", url: "/admin/team", headers: as(admin.token), payload: { email: "setengah@contoh.id" } });
    expect([incomplete.statusCode, incomplete.json().galat]).toEqual([409, "akun_belum_lengkap"]);
    const self = await app.inject({ method: "POST", url: "/admin/team", headers: as(admin.token), payload: { email: "admin@contoh.id" } });
    expect(self.json()).toMatchObject({ role: "admin" });
    expect(await roleOf(admin.user.id)).toBe("admin");
  });

  it("revokes verifiers but never admins", async () => {
    const member = await helpers.reporter("keluar@contoh.id");
    await app.inject({ method: "POST", url: "/admin/team", headers: as(admin.token), payload: { email: "keluar@contoh.id" } });
    const removed = await app.inject({ method: "DELETE", url: `/admin/team/${member.user.id}`, headers: as(admin.token) });
    expect(removed.statusCode).toBe(204);
    expect(await roleOf(member.user.id)).toBe("pengguna");

    const again = await app.inject({ method: "DELETE", url: `/admin/team/${member.user.id}`, headers: as(admin.token) });
    expect([again.statusCode, again.json().galat]).toEqual([404, "bukan_anggota_tim"]);
    const adminRevoke = await app.inject({ method: "DELETE", url: `/admin/team/${admin.user.id}`, headers: as(admin.token) });
    expect([adminRevoke.statusCode, adminRevoke.json().galat]).toEqual([409, "admin_lewat_skrip"]);
  });
});
