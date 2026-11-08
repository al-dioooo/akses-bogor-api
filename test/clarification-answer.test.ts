import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, photos, reportClarifications, reportEmails, reports } from "../src/db/schema.js";
import { expireClarifications } from "../src/verification/jobs.js";
import { verificationRig, type Rig } from "./helpers/verification.js";

const HOUR = 3600_000;

let rig: Rig;
let reporter: { token: string; user: { id: string } };
let verifier: { token: string; user: { id: string } };

beforeAll(async () => {
  rig = await verificationRig();
  reporter = await rig.helpers.reporter("pelapor@contoh.id", "Warga Bogor");
  verifier = await rig.verifier("verifikator@contoh.id");
}, 90_000);

afterAll(async () => {
  await rig.close();
});

const ask = (id: string, question = "Bisakah Anda menambahkan foto pintu masuk?") =>
  rig.app.inject({ method: "POST", url: `/verifier/reports/${id}/clarify`, headers: rig.as(verifier.token), payload: { question } });
const answer = (id: string, payload: object, token = reporter.token) =>
  rig.app.inject({ method: "POST", url: `/me/reports/${id}/clarification`, headers: rig.as(token), payload });
const statusOf = async (id: string) => (await rig.db.select({ status: reports.status, reason: reports.rejectionReason }).from(reports).where(eq(reports.id, id)))[0]!;

describe("answering a clarification (FR-41, ADR-0036)", () => {
  it("shows the question to the reporter only", async () => {
    const id = await rig.submit(reporter.token, rig.newPlace({ name: "Masjid tanya contoh" }));
    await ask(id);
    const res = await rig.app.inject({ method: "GET", url: `/me/reports/${id}`, headers: rig.as(reporter.token) });
    expect(res.json()).toMatchObject({
      id,
      status: "klarifikasi",
      placeName: "Masjid tanya contoh",
      photos: 0,
      clarifications: [{ question: "Bisakah Anda menambahkan foto pintu masuk?", dueAt: "2026-11-15T03:00:00.000Z", answer: null, answeredAt: null }],
    });
    const other = await rig.helpers.reporter("lain@contoh.id");
    expect((await rig.app.inject({ method: "GET", url: `/me/reports/${id}`, headers: rig.as(other.token) })).statusCode).toBe(404);
    expect((await answer(id, { answer: "Bukan laporan saya" }, other.token)).statusCode).toBe(404);
  });

  it("takes text and new photos, and puts the report back in its original place in the queue", async () => {
    rig.clock.now = new Date("2026-11-08T04:00:00.000Z");
    const older = await rig.submit(reporter.token, rig.newPlace({ name: "Halte lama contoh" }));
    rig.clock.now = new Date("2026-11-08T05:00:00.000Z");
    const newer = await rig.submit(reporter.token, rig.newPlace({ name: "Halte baru contoh" }));
    await ask(older);
    rig.clock.now = new Date("2026-11-09T05:00:00.000Z");
    const photo = await rig.uploadPhoto(reporter.token);
    const res = await answer(older, { answer: "Foto pintu masuk sudah saya tambahkan.", photos: [{ id: photo, tag: "pintu_masuk", caption: "Dari parkir" }] });
    expect(res.json()).toEqual({ status: "menunggu" });

    const queue = (await rig.app.inject({ method: "GET", url: "/verifier/reports", headers: rig.as(verifier.token) })).json().items as { id: string; answered: boolean }[];
    const ids = queue.map((i) => i.id);
    expect(ids.indexOf(older)).toBeLessThan(ids.indexOf(newer));
    expect(queue.find((i) => i.id === older)!.answered).toBe(true);

    const review = (await rig.app.inject({ method: "GET", url: `/verifier/reports/${older}`, headers: rig.as(verifier.token) })).json();
    expect(review.clarifications).toEqual([expect.objectContaining({ answer: "Foto pintu masuk sudah saya tambahkan.", answeredAt: "2026-11-09T05:00:00.000Z" })]);
    expect(review.photos).toEqual([expect.objectContaining({ id: photo, tag: "pintu_masuk", caption: "Dari parkir", clarificationId: review.clarifications[0].id })]);
    expect(await rig.db.select().from(reportEmails).where(and(eq(reportEmails.reportId, older), eq(reportEmails.kind, "klarifikasi")))).toEqual([]);
    const [entry] = await rig.db.select().from(auditLog).where(and(eq(auditLog.entityId, older), eq(auditLog.action, "klarifikasi_dijawab")));
    expect(entry).toMatchObject({ actorId: reporter.user.id, changes: { status: { sebelum: "klarifikasi", sesudah: "menunggu" }, fotoBaru: 1 } });
    expect(JSON.stringify(entry)).not.toContain("saya tambahkan");

    const twice = await answer(older, { answer: "Lagi" });
    expect([twice.statusCode, twice.json().galat]).toEqual([409, "tidak_menunggu_jawaban"]);

    // Putaran kedua punya tenggat sendiri.
    await ask(older, "Apakah toiletnya untuk umum?");
    expect((await answer(older, { answer: "Ya, untuk umum." })).statusCode).toBe(200);
    expect(await rig.db.select().from(reportClarifications).where(eq(reportClarifications.reportId, older))).toHaveLength(2);
  });

  it("keeps the report at ten photos or fewer and only takes the reporter's own uploads", async () => {
    const existing = await Promise.all(Array.from({ length: 9 }, () => rig.uploadPhoto(reporter.token)));
    const id = await rig.submit(reporter.token, { ...rig.newPlace({ name: "Kampus penuh contoh" }), photos: existing.map((photo) => ({ id: photo, tag: "lainnya" })) });
    await ask(id);
    const extra = [await rig.uploadPhoto(reporter.token), await rig.uploadPhoto(reporter.token)];
    const tooMany = await answer(id, { answer: "Dua foto lagi", photos: extra.map((photo) => ({ id: photo, tag: "lift" })) });
    expect([tooMany.statusCode, tooMany.json().galat]).toEqual([400, "foto_terlalu_banyak"]);
    const someoneElse = await rig.uploadPhoto((await rig.helpers.reporter("orang-lain@contoh.id")).token);
    const foreign = await answer(id, { answer: "Foto orang lain", photos: [{ id: someoneElse, tag: "lift" }] });
    expect([foreign.statusCode, foreign.json().galat]).toEqual([400, "foto_tidak_ditemukan"]);
    expect((await answer(id, { answer: "Satu foto lagi", photos: [{ id: extra[0], tag: "lift" }] })).statusCode).toBe(200);
  });

  it("refuses answers after the deadline", async () => {
    const id = await rig.submit(reporter.token, rig.newPlace({ name: "Halte telat contoh" }));
    await ask(id);
    rig.clock.now = new Date(rig.clock.now.getTime() + 7 * 24 * HOUR);
    const late = await answer(id, { answer: "Maaf terlambat" });
    expect([late.statusCode, late.json().galat]).toEqual([409, "tenggat_lewat"]);
  });
});

describe("expireClarifications (R6)", () => {
  it("rejects reports whose deadline passed, with the system as actor, and leaves the rest", async () => {
    // Klarifikasi dari tes sebelumnya yang sudah lewat tenggat ditolak lebih dulu.
    expect(await expireClarifications(rig.db, rig.memory.store, new Date("2026-11-30T00:00:00.000Z"))).toBe(2);
    rig.clock.now = new Date("2026-12-01T00:00:00.000Z");
    const photo = await rig.uploadPhoto(reporter.token);
    const expiring = await rig.submit(reporter.token, { ...rig.newPlace({ name: "Masjid diam contoh" }), photos: [{ id: photo, tag: "pintu_masuk" }] });
    const fresh = await rig.submit(reporter.token, rig.newPlace({ name: "Masjid baru ditanya contoh" }));
    await ask(expiring);
    rig.clock.now = new Date("2026-12-04T00:00:00.000Z");
    await ask(fresh);

    // Tepat sebelum tenggat belum ditolak.
    expect(await expireClarifications(rig.db, rig.memory.store, new Date("2026-12-07T23:59:59.000Z"))).toBe(0);
    const expired = await expireClarifications(rig.db, rig.memory.store, new Date("2026-12-08T00:30:00.000Z"));
    expect(expired).toBe(1);
    expect(await statusOf(expiring)).toEqual({ status: "ditolak", reason: "tidak_ada_klarifikasi" });
    expect(await statusOf(fresh)).toEqual({ status: "klarifikasi", reason: null });
    expect(await rig.db.select().from(photos).where(eq(photos.reportId, expiring))).toEqual([]);
    expect(rig.memory.files.has(`laporan/${photo}.webp`)).toBe(false);
    const [entry] = await rig.db.select().from(auditLog).where(and(eq(auditLog.entityId, expiring), eq(auditLog.action, "ditolak")));
    expect(entry).toMatchObject({ actorId: null, actorLabel: "sistem", changes: { alasan: "tidak_ada_klarifikasi" } });
    expect(await rig.db.select({ kind: reportEmails.kind }).from(reportEmails).where(eq(reportEmails.reportId, expiring))).toEqual(
      expect.arrayContaining([{ kind: "ditolak" }]),
    );
    expect(await expireClarifications(rig.db, rig.memory.store, new Date("2026-12-08T01:30:00.000Z"))).toBe(0);
  });
});
