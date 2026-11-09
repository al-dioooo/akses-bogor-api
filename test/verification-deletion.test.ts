import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { auditLog, photoDeletions, photos, places, reportClarifications, reportEmails, reports, users } from "../src/db/schema.js";
import { facilities, verificationRig, type Rig } from "./helpers/verification.js";

let rig: Rig;
let reporter: { token: string; user: { id: string } };
let verifier: { token: string; user: { id: string } };
let published: string;
let placeId: string;
let publishedPhoto: string;
let asking: string;
let askingPhotos: string[];
let rejected: string;

const post = (url: string, payload: object, token = verifier.token) => rig.app.inject({ method: "POST", url, headers: rig.as(token), payload });
const checked = () => facilities({ ramp: { answer: "tersedia" } }).map((f) => ({ reason: null, note: null, evidence: "terbukti", ...f }));

beforeAll(async () => {
  rig = await verificationRig();
  reporter = await rig.helpers.reporter("pelapor@contoh.id", "Warga Bogor");
  verifier = await rig.verifier("verifikator@contoh.id");

  // Laporan terbit dengan satu putaran klarifikasi yang dijawab.
  publishedPhoto = await rig.uploadPhoto(reporter.token);
  published = await rig.submit(reporter.token, { ...rig.newPlace(), photos: [{ id: publishedPhoto, tag: "pintu_masuk" }] });
  await post(`/verifier/reports/${published}/clarify`, { question: "Ada foto ramp dari dekat?" });
  await post(`/me/reports/${published}/clarification`, { answer: "Foto pertama sudah dari dekat." }, reporter.token);
  placeId = (await post(`/verifier/reports/${published}/publish`, { name: "Masjid Al-Ikhlas contoh", category: "masjid", location: { lat: -6.5976, lng: 106.7991 }, description: null, facilities: checked() })).json().placeId;

  // Laporan yang menunggu jawaban klarifikasi, dengan foto dari laporan awal dan dari jawaban sebelumnya.
  askingPhotos = [await rig.uploadPhoto(reporter.token), await rig.uploadPhoto(reporter.token)];
  asking = await rig.submit(reporter.token, { ...rig.newPlace({ name: "Halte tanya contoh" }), photos: [{ id: askingPhotos[0], tag: "lainnya" }] });
  await post(`/verifier/reports/${asking}/clarify`, { question: "Pintu mana yang dipakai?" });
  await post(`/me/reports/${asking}/clarification`, { answer: "Pintu timur.", photos: [{ id: askingPhotos[1], tag: "pintu_masuk" }] }, reporter.token);
  rig.mail.failing = true;
  await post(`/verifier/reports/${asking}/clarify`, { question: "Ada foto toilet?" });
  rig.mail.failing = false;

  rejected = await rig.submit(reporter.token, rig.newPlace({ name: "Kampus tolak contoh" }));
  await post(`/verifier/reports/${rejected}/reject`, { reason: "duplikat" });
}, 120_000);

afterAll(async () => {
  await rig.close();
});

describe("deleting a reporter account (ADR-0024)", () => {
  it("removes unpublished reports with their clarifications, photos, and pending emails", async () => {
    expect((await rig.app.inject({ method: "DELETE", url: "/me", headers: rig.as(reporter.token) })).statusCode).toBe(204);

    const left = await rig.db.select({ id: reports.id }).from(reports).where(inArray(reports.id, [published, asking, rejected]));
    expect(left).toEqual([{ id: published }]);
    expect(await rig.db.select().from(reportClarifications).where(eq(reportClarifications.reportId, asking))).toEqual([]);
    expect(await rig.db.select().from(photos).where(inArray(photos.id, askingPhotos))).toEqual([]);
    const queued = (await rig.db.select().from(photoDeletions)).map((d) => d.storageKey);
    expect(queued).toEqual(expect.arrayContaining(askingPhotos.map((id) => `laporan/${id}.webp`)));
    expect(await rig.db.select().from(reportEmails).where(eq(reportEmails.reportId, asking))).toEqual([]);
  });

  it("keeps the published place, photo, and clarification without the reporter", async () => {
    const [report] = await rig.db.select({ reporterId: reports.reporterId, status: reports.status }).from(reports).where(eq(reports.id, published));
    expect(report).toEqual({ reporterId: null, status: "diterbitkan" });
    expect(await rig.db.select({ id: places.id }).from(places).where(eq(places.id, placeId))).toHaveLength(1);
    expect(await rig.db.select({ moderation: photos.moderation }).from(photos).where(eq(photos.id, publishedPhoto))).toEqual([{ moderation: "tayang" }]);

    const review = (await rig.app.inject({ method: "GET", url: `/verifier/reports/${published}`, headers: rig.as(verifier.token) })).json();
    expect(review).toMatchObject({ reporterName: null, clarifications: [{ answer: "Foto pertama sudah dari dekat." }] });
    // Jawaban pelapor yang terhapus tercatat tanpa pengubah, artinya "akun dihapus" (ADR-0038).
    const answered = await rig.db.select({ actorId: auditLog.actorId, actorLabel: auditLog.actorLabel }).from(auditLog).where(eq(auditLog.action, "klarifikasi_dijawab"));
    expect(answered.every((e) => e.actorId === null && e.actorLabel === null)).toBe(true);
    expect(JSON.stringify(await rig.db.select().from(auditLog))).not.toContain("pelapor@contoh.id");
  });
});

describe("deleting a verifier account (ADR-0024)", () => {
  it("keeps the decisions and the place, with the verifier removed from reports, questions, and the audit log", async () => {
    expect((await rig.app.inject({ method: "DELETE", url: "/me", headers: rig.as(verifier.token) })).statusCode).toBe(204);
    expect(await rig.db.select().from(users).where(eq(users.id, verifier.user.id))).toEqual([]);
    const [report] = await rig.db.select({ reviewerId: reports.reviewerId, status: reports.status }).from(reports).where(eq(reports.id, published));
    expect(report).toEqual({ reviewerId: null, status: "diterbitkan" });
    expect((await rig.db.select({ askedBy: reportClarifications.askedBy }).from(reportClarifications).where(eq(reportClarifications.reportId, published)))[0]!.askedBy).toBeNull();
    const decisions = await rig.db.select({ actorId: auditLog.actorId }).from(auditLog).where(eq(auditLog.entityId, placeId));
    expect(decisions).toEqual([{ actorId: null }]);
    expect((await rig.app.inject({ method: "GET", url: `/places/${placeId}` })).statusCode).toBe(200);
  });
});
