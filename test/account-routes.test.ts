import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import { buildApp } from "../src/app.js";
import { cleanUpAccounts } from "../src/auth/cleanup.js";
import { PRIVACY_POLICY_VERSION } from "../src/auth/rules.js";
import { loadEnv } from "../src/config/env.js";
import type { Db } from "../src/db/client.js";
import { auditLog, photos, places, reports } from "../src/db/schema.js";
import { seedSampleData } from "../src/db/seed.js";
import type { Email, Mailer } from "../src/email/mailer.js";
import { createTestDb } from "./helpers/db.js";
import { googleCertsFetch, googleIdToken } from "./helpers/google.js";

const env = loadEnv({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test@localhost/test",
  BETTER_AUTH_SECRET: "rahasia-tes-yang-panjangnya-lebih-dari-32-karakter",
  GOOGLE_CLIENT_ID: "client-tes",
});

let app: Awaited<ReturnType<typeof buildApp>>;
let db: Db;
let client: PGlite;
let close: () => Promise<void>;
let placeId: string;
const sent: Email[] = [];
let failEmails = false;
const mailer: Mailer = async (email) => {
  if (failEmails) throw new Error("Resend menjawab 500");
  sent.push(email);
};

beforeAll(async () => {
  const test = await createTestDb();
  ({ db, client, close } = test);
  await seedSampleData(db);
  placeId = (await db.select({ id: places.id }).from(places).limit(1))[0]!.id;
  vi.stubGlobal("fetch", googleCertsFetch());
  app = await buildApp(env, { db, mailer });
  await app.ready();
}, 60_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
  await close();
});

let ipCounter = 10;
const auth = (token: string) => ({ authorization: `Bearer ${token}`, "x-forwarded-for": `198.51.100.${ipCounter++}` });

async function signIn(email: string) {
  const ip = `192.0.2.${ipCounter++}`;
  await app.inject({ method: "POST", url: "/auth/code", payload: { email }, remoteAddress: ip });
  const code = sent.at(-1)!.subject.slice(-6);
  const res = await app.inject({ method: "POST", url: "/auth/code/verify", payload: { email, code }, remoteAddress: ip });
  return res.json() as { token: string; user: { id: string } };
}

const complete = (token: string, payload: object) => app.inject({ method: "POST", url: "/me/complete", payload, headers: auth(token) });
const consent = { displayName: "Sari", acceptPrivacyPolicy: true, privacyPolicyVersion: PRIVACY_POLICY_VERSION };

async function completeAccount(email: string, name = "Sari") {
  const session = await signIn(email);
  await complete(session.token, { ...consent, displayName: name });
  return session;
}

describe("POST /me/complete", () => {
  it("saves the display name, the consent time, and the policy version", async () => {
    const { token, user } = await signIn("lengkap@contoh.id");
    const res = await complete(token, { ...consent, displayName: "  Sari Lestari  " });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ displayName: "Sari Lestari", needsCompletion: false });
    const { rows } = await client.query("SELECT privacy_consent_at IS NOT NULL AS consented, privacy_policy_version FROM users WHERE id = $1", [user.id]);
    expect(rows).toEqual([{ consented: true, privacy_policy_version: PRIVACY_POLICY_VERSION }]);
  });

  it("needs the consent box and a non-empty name", async () => {
    const { token } = await signIn("belum-setuju@contoh.id");
    expect((await complete(token, { ...consent, acceptPrivacyPolicy: false })).statusCode).toBe(400);
    expect((await complete(token, { ...consent, displayName: "   " })).statusCode).toBe(400);
    expect((await complete(token, { ...consent, displayName: "x".repeat(61) })).statusCode).toBe(400);
  });

  it("refuses consent to another policy version", async () => {
    const { token } = await signIn("versi@contoh.id");
    const res = await complete(token, { ...consent, privacyPolicyVersion: "2020-01-01" });
    expect(res.statusCode).toBe(409);
    expect(res.json().galat).toBe("versi_kebijakan_berbeda");
  });

  it("asks again after the policy version changes", async () => {
    const { token, user } = await completeAccount("versi-lama@contoh.id");
    await client.query("UPDATE users SET privacy_policy_version = '2020-01-01' WHERE id = $1", [user.id]);
    const res = await app.inject({ method: "GET", url: "/me", headers: auth(token) });
    expect(res.json().needsCompletion).toBe(true);
  });
});

describe("PATCH /me", () => {
  it("renames a completed account and refuses an incomplete one", async () => {
    const incomplete = await signIn("ganti-belum@contoh.id");
    const refused = await app.inject({ method: "PATCH", url: "/me", payload: { displayName: "Baru" }, headers: auth(incomplete.token) });
    expect(refused.statusCode).toBe(403);

    const { token } = await completeAccount("ganti@contoh.id");
    const res = await app.inject({ method: "PATCH", url: "/me", payload: { displayName: "Nama Baru" }, headers: auth(token) });
    expect(res.json()).toMatchObject({ displayName: "Nama Baru", email: "ganti@contoh.id" });
  });
});

async function addReport(reporterId: string, values: Partial<typeof reports.$inferInsert>, photoModerations: ("menunggu" | "tayang" | "disembunyikan")[] = []) {
  const [report] = await db
    .insert(reports)
    .values({ kind: "baru", submission: { name: "Tempat baru" }, reporterId, ...values })
    .returning({ id: reports.id });
  for (const [i, moderation] of photoModerations.entries()) {
    await db.insert(photos).values({
      reportId: report!.id,
      placeId: values.status === "diterbitkan" ? placeId : null,
      storageKey: `laporan/${report!.id}/${i}.webp`,
      altText: "Foto pintu masuk",
      width: 1600,
      height: 1200,
      bytes: 300_000,
      moderation,
    });
  }
  return report!.id;
}

describe("GET /me/reports", () => {
  it("starts empty", async () => {
    const { token } = await completeAccount("kosong@contoh.id");
    const res = await app.inject({ method: "GET", url: "/me/reports", headers: auth(token) });
    expect(res.json()).toEqual({ items: [] });
  });

  it("lists only my reports, newest first, with status, place name, and reason", async () => {
    const mine = await completeAccount("pelapor@contoh.id");
    const other = await completeAccount("orang-lain@contoh.id");
    await addReport(other.user.id, {});
    await addReport(mine.user.id, { submission: { name: "Masjid baru" }, submittedAt: new Date("2026-11-01T00:00:00Z") });
    await addReport(mine.user.id, {
      kind: "kekurangan",
      placeId,
      status: "ditolak",
      rejectionReason: "bukti_tidak_cukup",
      submittedAt: new Date("2026-11-03T00:00:00Z"),
      decidedAt: new Date("2026-11-04T00:00:00Z"),
    });
    await addReport(mine.user.id, { status: "klarifikasi", clarificationQuestion: "Di lantai berapa liftnya?", submittedAt: new Date("2026-11-05T00:00:00Z") });

    const res = await app.inject({ method: "GET", url: "/me/reports", headers: auth(mine.token) });
    const items = res.json().items;
    const [place] = await db.select({ name: places.name }).from(places).where(eq(places.id, placeId));
    expect(items.map((i: { status: string }) => i.status)).toEqual(["klarifikasi", "ditolak", "menunggu"]);
    expect(items[0]).toMatchObject({ placeName: "Tempat baru", clarificationQuestion: "Di lantai berapa liftnya?" });
    expect(items[1]).toMatchObject({ kind: "kekurangan", placeName: place!.name, rejectionReason: "bukti_tidak_cukup", decidedAt: "2026-11-04T00:00:00.000Z" });
    expect(items[2]).toMatchObject({ placeName: "Masjid baru", placeId: null, rejectionReason: null });
  });
});

describe("DELETE /me (ADR-0024)", () => {
  it("removes personal data and unpublished reports, and keeps published data without the reporter", async () => {
    const { token, user } = await completeAccount("hapus@contoh.id");
    const other = await completeAccount("tetap@contoh.id");
    const waiting = await addReport(user.id, {}, ["menunggu"]);
    const rejected = await addReport(user.id, { status: "ditolak", rejectionReason: "duplikat" }, ["menunggu"]);
    const clarifying = await addReport(user.id, { status: "klarifikasi" });
    const published = await addReport(user.id, { kind: "kekurangan", placeId, status: "diterbitkan" }, ["tayang", "disembunyikan"]);
    const othersReport = await addReport(other.user.id, {}, ["menunggu"]);
    await db.insert(auditLog).values({ entityType: "report", entityId: published, actorId: user.id, action: "kirim" });
    await app.inject({ method: "POST", url: "/auth/google", payload: { idToken: googleIdToken({ email: "hapus@contoh.id", sub: "4001" }) }, remoteAddress: "192.0.2.250" });

    sent.length = 0;
    const res = await app.inject({ method: "DELETE", url: "/me", headers: auth(token) });
    expect(res.statusCode).toBe(204);

    const count = async (sql: string, params: unknown[] = []) => (await client.query<{ n: number }>(sql, params)).rows[0]!.n;
    expect(await count("SELECT count(*)::int AS n FROM users WHERE id = $1", [user.id])).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM sessions WHERE user_id = $1", [user.id])).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM accounts WHERE user_id = $1", [user.id])).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM reports WHERE id = ANY($1)", [[waiting, rejected, clarifying]])).toBe(0);

    const kept = await client.query("SELECT reporter_id FROM reports WHERE id = $1", [published]);
    expect(kept.rows).toEqual([{ reporter_id: null }]);
    const keptPhotos = await client.query("SELECT moderation FROM photos WHERE report_id = $1", [published]);
    expect(keptPhotos.rows).toEqual([{ moderation: "tayang" }]);
    const queued = await client.query<{ storage_key: string }>("SELECT storage_key FROM photo_deletions ORDER BY storage_key");
    expect(queued.rows.map((r) => r.storage_key).sort()).toEqual(
      [`laporan/${waiting}/0.webp`, `laporan/${rejected}/0.webp`, `laporan/${published}/1.webp`].sort(),
    );
    expect((await client.query("SELECT actor_id, actor_label FROM audit_log WHERE entity_id = $1", [published])).rows).toEqual([
      { actor_id: null, actor_label: null },
    ]);
    expect(await count("SELECT count(*)::int AS n FROM reports WHERE id = $1 AND reporter_id = $2", [othersReport, other.user.id])).toBe(1);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "hapus@contoh.id", subject: "Akun AksesBogor Anda sudah dihapus" });
    expect((await app.inject({ method: "GET", url: "/me", headers: auth(token) })).statusCode).toBe(401);
  });

  it("gives a new, empty account when the same email signs in again", async () => {
    const first = await completeAccount("ulang@contoh.id");
    await addReport(first.user.id, {});
    await app.inject({ method: "DELETE", url: "/me", headers: auth(first.token) });

    // Lewati jeda 60 detik antar kode untuk email yang sama.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    const again = await signIn("ulang@contoh.id");
    vi.restoreAllMocks();
    expect(again.user.id).not.toBe(first.user.id);
    const res = await app.inject({ method: "GET", url: "/me/reports", headers: auth(again.token) });
    expect(res.json()).toEqual({ items: [] });
  });

  it("still deletes the account when the confirmation email fails", async () => {
    const { token, user } = await completeAccount("email-gagal@contoh.id");
    failEmails = true;
    try {
      expect((await app.inject({ method: "DELETE", url: "/me", headers: auth(token) })).statusCode).toBe(204);
    } finally {
      failEmails = false;
    }
    expect((await client.query("SELECT 1 FROM users WHERE id = $1", [user.id])).rows).toEqual([]);
  });
});

describe("cleanUpAccounts", () => {
  it("removes incomplete accounts after 24 hours, and expired sessions and codes", async () => {
    const stale = await signIn("terbengkalai@contoh.id");
    const fresh = await signIn("baru-saja@contoh.id");
    const completed = await completeAccount("rajin@contoh.id");
    const withReport = await signIn("punya-laporan@contoh.id");
    await addReport(withReport.user.id, {});
    await client.query("UPDATE users SET created_at = now() - interval '25 hours' WHERE id = ANY($1)", [
      [stale.user.id, completed.user.id, withReport.user.id],
    ]);
    await client.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1", [completed.user.id]);
    await app.inject({ method: "POST", url: "/auth/code", payload: { email: "kode-lama@contoh.id" }, remoteAddress: "192.0.2.251" });
    await client.query("UPDATE verifications SET expires_at = now() - interval '1 minute' WHERE identifier = 'sign-in-otp-kode-lama@contoh.id'");

    const removed = await cleanUpAccounts(db, new Date());
    expect(removed.users).toBe(1);
    expect(removed.sessions).toBeGreaterThanOrEqual(1);
    expect(removed.codes).toBeGreaterThanOrEqual(1);

    const remaining = await client.query<{ id: string }>("SELECT id FROM users WHERE id = ANY($1)", [
      [stale.user.id, fresh.user.id, completed.user.id, withReport.user.id],
    ]);
    expect(remaining.rows.map((r) => r.id).sort()).toEqual([fresh.user.id, completed.user.id, withReport.user.id].sort());
  });
});
