import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, photoDeletions, photos, reportClarifications, reportEmails, reports } from "../src/db/schema.js";
import { verificationRig, type Rig } from "./helpers/verification.js";

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

const decide = (token: string, id: string, action: "reject" | "clarify", payload: object) =>
  rig.app.inject({ method: "POST", url: `/verifier/reports/${id}/${action}`, headers: rig.as(token), payload });

const myReports = async () => (await rig.app.inject({ method: "GET", url: "/me/reports", headers: rig.as(reporter.token) })).json().items as Record<string, unknown>[];

async function reportWithPhotos(name: string) {
  const ids = [await rig.uploadPhoto(reporter.token), await rig.uploadPhoto(reporter.token)];
  const id = await rig.submit(reporter.token, { ...rig.newPlace({ name }), photos: ids.map((photo) => ({ id: photo, tag: "pintu_masuk" })) });
  return { id, photos: ids };
}

describe("POST /verifier/reports/:id/reject (FR-32)", () => {
  it("rejects with a standard reason, deletes the photos, and queues the email", async () => {
    const { id, photos: photoIds } = await reportWithPhotos("Masjid duplikat contoh");
    const res = await decide(verifier.token, id, "reject", { reason: "duplikat", note: "Sama dengan Masjid contoh A" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ditolak", rejectionReason: "duplikat" });

    const [row] = await rig.db.select().from(reports).where(eq(reports.id, id));
    expect(row).toMatchObject({ status: "ditolak", rejectionReason: "duplikat", reviewerId: verifier.user.id, reviewerNote: "Sama dengan Masjid contoh A", decidedAt: rig.clock.now });
    expect(await rig.db.select().from(photos).where(eq(photos.reportId, id))).toEqual([]);
    for (const photo of photoIds) expect(rig.memory.files.has(`laporan/${photo}.webp`)).toBe(false);
    expect(await rig.db.select().from(photoDeletions)).toEqual([]);
    // Email langsung terkirim setelah keputusan, jadi antreannya kosong lagi (ADR-0039).
    expect(await rig.db.select().from(reportEmails).where(eq(reportEmails.reportId, id))).toEqual([]);
    expect(rig.sent.at(-1)).toMatchObject({ to: "pelapor@contoh.id", subject: "Laporan Anda belum bisa diterbitkan: Masjid duplikat contoh" });
    expect(rig.sent.at(-1)!.text).toContain("Tempat ini sudah ada di AksesBogor.");
    expect(rig.sent.at(-1)!.text).not.toContain("Sama dengan Masjid contoh A");
    const [entry] = await rig.db.select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, "ditolak")));
    expect(entry).toMatchObject({ entityType: "laporan", actorId: verifier.user.id, changes: { status: { sebelum: "menunggu", sesudah: "ditolak" }, alasan: "duplikat", fotoDihapus: 2 } });
    expect(JSON.stringify(entry)).not.toContain("Sama dengan");

    expect((await myReports()).find((r) => r.id === id)).toMatchObject({ status: "ditolak", rejectionReason: "duplikat" });
  });

  it("keeps file deletions queued when storage fails", async () => {
    const { id, photos: photoIds } = await reportWithPhotos("Halte gagal hapus contoh");
    rig.memory.failing.remove = true;
    expect((await decide(verifier.token, id, "reject", { reason: "bukti_tidak_cukup" })).statusCode).toBe(200);
    rig.memory.failing.remove = false;
    const queued = (await rig.db.select().from(photoDeletions)).map((d) => d.storageKey).sort();
    expect(queued).toEqual(photoIds.map((photo) => `laporan/${photo}.webp`).sort());
    await rig.db.delete(photoDeletions);
  });

  it("allows only R1 to R5, one decision per report, and never the verifier's own report", async () => {
    const id = await rig.submit(reporter.token, rig.newPlace({ name: "Kampus contoh D" }));
    expect((await decide(verifier.token, id, "reject", { reason: "tidak_ada_klarifikasi" })).statusCode).toBe(400);
    expect((await decide(reporter.token, id, "reject", { reason: "duplikat" })).statusCode).toBe(403);
    expect((await decide(verifier.token, id, "reject", { reason: "konten_tidak_pantas" })).statusCode).toBe(200);
    const again = await decide(verifier.token, id, "reject", { reason: "duplikat" });
    expect([again.statusCode, again.json().galat]).toEqual([409, "sudah_diputuskan"]);

    const own = await rig.submit(verifier.token, rig.newPlace({ name: "Laporan verifikator contoh" }));
    const res = await decide(verifier.token, own, "reject", { reason: "duplikat" });
    expect([res.statusCode, res.json().galat]).toEqual([403, "laporan_sendiri"]);
    expect((await decide(verifier.token, crypto.randomUUID(), "reject", { reason: "duplikat" })).statusCode).toBe(404);
  });
});

describe("POST /verifier/reports/:id/clarify (FR-32, FR-41)", () => {
  it("asks the reporter with a 7-day deadline and shows the question in Laporan saya", async () => {
    const id = await rig.submit(reporter.token, rig.newPlace({ name: "Rumah sakit tanya contoh" }));
    const question = "Bisakah Anda menambahkan foto pintu masuk utama dari area parkir?";
    const res = await decide(verifier.token, id, "clarify", { question });
    expect(res.json()).toEqual({ status: "klarifikasi", clarificationDueAt: "2026-11-15T03:00:00.000Z" });

    expect(await rig.db.select().from(reportClarifications).where(eq(reportClarifications.reportId, id))).toEqual([
      expect.objectContaining({ question, askedBy: verifier.user.id, askedAt: rig.clock.now, dueAt: new Date("2026-11-15T03:00:00.000Z"), answer: null }),
    ]);
    expect(await rig.db.select().from(reportEmails).where(eq(reportEmails.reportId, id))).toEqual([]);
    expect(rig.sent.at(-1)).toMatchObject({ to: "pelapor@contoh.id", subject: "Pertanyaan tentang laporan Anda: Rumah sakit tanya contoh" });
    expect(rig.sent.at(-1)!.text).toContain(question);
    expect(rig.sent.at(-1)!.text).toContain(`https://akses-bogor.contoh.id/akun/laporan/${id}`);
    expect(rig.sent.at(-1)!.text).toContain("15 November 2026 pukul 10.00 WIB");
    const [entry] = await rig.db.select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, "klarifikasi_diminta")));
    expect(JSON.stringify(entry!.changes)).not.toContain("parkir");
    expect((await myReports()).find((r) => r.id === id)).toMatchObject({ status: "klarifikasi", clarificationQuestion: question, clarificationDueAt: "2026-11-15T03:00:00.000Z" });

    const second = await decide(verifier.token, id, "clarify", { question: "Lagi?" });
    expect([second.statusCode, second.json().galat]).toEqual([409, "klarifikasi_terbuka"]);
    // Verifikator tetap bisa menolak sebelum pelapor menjawab, mis. setelah menelepon pengelola.
    expect((await decide(verifier.token, id, "reject", { reason: "bukan_fasilitas_publik" })).statusCode).toBe(200);
    expect((await myReports()).find((r) => r.id === id)).toMatchObject({ status: "ditolak", clarificationQuestion: null });
  });

  it("refuses empty questions", async () => {
    const id = await rig.submit(reporter.token, rig.newPlace({ name: "Masjid kosong contoh" }));
    expect((await decide(verifier.token, id, "clarify", { question: "   " })).statusCode).toBe(400);
  });
});
