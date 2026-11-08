import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { places, reports, users } from "../src/db/schema.js";
import { facilities, verificationRig, type Rig } from "./helpers/verification.js";

let rig: Rig;
let reporter: { token: string; user: { id: string } };
let verifier: { token: string; user: { id: string } };
let reportingVerifier: { token: string; user: { id: string } };
let newReport: string;
let ownReport: string;
let deficiency: string;
let halteId: string;

beforeAll(async () => {
  rig = await verificationRig();
  reporter = await rig.helpers.reporter("pelapor@contoh.id", "Warga Bogor");
  verifier = await rig.verifier("verifikator@contoh.id", "Verifikator Satu");
  reportingVerifier = await rig.verifier("verifikator-pelapor@contoh.id", "Verifikator Dua");
  halteId = await rig.placeId("Halte contoh");

  rig.clock.now = new Date("2026-11-08T01:00:00.000Z");
  ownReport = await rig.submit(reportingVerifier.token, rig.newPlace({ name: "Kampus contoh C", category: "kampus", location: { lat: -6.5958, lng: 106.7942 } }));
  rig.clock.now = new Date("2026-11-08T02:00:00.000Z");
  const photo = await rig.uploadPhoto(reporter.token);
  newReport = await rig.submit(reporter.token, { ...rig.newPlace(), photos: [{ id: photo, tag: "pintu_masuk" }] });
  rig.clock.now = new Date("2026-11-08T03:00:00.000Z");
  // Formulir kekurangan terisi data Halte contoh; pelapor hanya mengubah lift dari Tersedia menjadi Tidak tersedia.
  deficiency = await rig.submit(reporter.token, {
    kind: "kekurangan",
    placeId: halteId,
    facilities: facilities({
      ramp: { answer: "tersedia" },
      toilet_difabel: { answer: "tidak_perlu" },
      guiding_block: { answer: "tidak_tersedia", reason: "tidak_sesuai" },
      lift: { answer: "tidak_tersedia", reason: "rusak", note: "Rusak sejak awal November" },
    }),
  });
}, 90_000);

afterAll(async () => {
  await rig.close();
});

const queue = (token: string, status?: string) =>
  rig.app.inject({ method: "GET", url: `/verifier/reports${status ? `?status=${status}` : ""}`, headers: rig.as(token) });

describe("GET /verifier/reports (FR-30)", () => {
  it("lists waiting reports oldest first with the reporter's display name only", async () => {
    const res = await queue(verifier.token);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { total: number; items: { id: string; reporterName: string; photos: number; kind: string; worsens: boolean }[] };
    expect(body.items.map((i) => i.id)).toEqual([ownReport, newReport, deficiency]);
    expect(body.total).toBe(3);
    expect(body.items[1]).toMatchObject({ kind: "baru", name: "Masjid Al-Ikhlas contoh", category: "masjid", reporterName: "Warga Bogor", photos: 1, answered: false, worsens: false });
    expect(body.items[2]).toMatchObject({ kind: "kekurangan", placeId: halteId, name: "Halte contoh", worsens: true });
    expect(res.body).not.toContain("@contoh.id");
  });

  it("never shows a verifier their own reports (FR-37)", async () => {
    const body = (await queue(reportingVerifier.token)).json() as { total: number; items: { id: string }[] };
    expect(body.items.map((i) => i.id)).toEqual([newReport, deficiency]);
    expect(body.total).toBe(2);
  });

  it("lists reports waiting for a clarification answer separately", async () => {
    await rig.db.update(reports).set({ status: "klarifikasi", clarificationQuestion: "Foto pintu masuk?", clarificationDueAt: new Date("2026-11-15T03:00:00.000Z") }).where(eq(reports.id, newReport));
    const waiting = (await queue(verifier.token, "klarifikasi")).json() as { items: { id: string; clarificationDueAt: string }[] };
    expect(waiting.items).toEqual([expect.objectContaining({ id: newReport, clarificationDueAt: "2026-11-15T03:00:00.000Z" })]);
    expect(((await queue(verifier.token)).json() as { items: { id: string }[] }).items.map((i) => i.id)).not.toContain(newReport);
    await rig.db.update(reports).set({ status: "menunggu", clarificationQuestion: null, clarificationDueAt: null }).where(eq(reports.id, newReport));
  });

  it("is closed to signed-out users and reporters, and to verifiers once their role is revoked", async () => {
    expect((await rig.app.inject({ method: "GET", url: "/verifier/reports" })).statusCode).toBe(401);
    const asReporter = await queue(reporter.token);
    expect([asReporter.statusCode, asReporter.json().galat]).toEqual([403, "bukan_verifikator"]);
    const former = await rig.verifier("mantan@contoh.id");
    expect((await queue(former.token)).statusCode).toBe(200);
    await rig.db.update(users).set({ role: "pengguna" }).where(eq(users.id, former.user.id));
    expect((await queue(former.token)).statusCode).toBe(403);
  });
});

describe("GET /verifier/places/recheck (FR-38)", () => {
  it("lists places verified more than 12 months ago, oldest first", async () => {
    const old = await rig.placeId("Masjid contoh B");
    const older = await rig.placeId("Kampus contoh B");
    await rig.db.update(places).set({ lastVerifiedAt: new Date("2025-10-01T00:00:00Z") }).where(eq(places.id, old));
    await rig.db.update(places).set({ lastVerifiedAt: new Date("2025-06-01T00:00:00Z") }).where(eq(places.id, older));
    const res = await rig.app.inject({ method: "GET", url: "/verifier/places/recheck", headers: rig.as(verifier.token) });
    // Halte contoh B dari data contoh terakhir diverifikasi 2025-08-01.
    expect(res.json()).toEqual({
      total: 3,
      items: [
        expect.objectContaining({ id: older, name: "Kampus contoh B", lastVerifiedAt: "2025-06-01T00:00:00.000Z" }),
        expect.objectContaining({ name: "Halte contoh B", lastVerifiedAt: "2025-08-01T03:00:00.000Z" }),
        expect.objectContaining({ id: old, name: "Masjid contoh B", district: { slug: "bogor-selatan", name: "Bogor Selatan" } }),
      ],
    });
  });
});
