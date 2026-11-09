import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, count, eq } from "drizzle-orm";
import { auditLog, photoDeletions, photos, placeFacilities, places, reportEmails, reports } from "../src/db/schema.js";
import { blurPhoto } from "../src/photos/blur.js";
import { facilities, verificationRig, type Rig } from "./helpers/verification.js";

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

const publish = (id: string, payload: object, token = verifier.token) =>
  rig.app.inject({ method: "POST", url: `/verifier/reports/${id}/publish`, headers: rig.as(token), payload });
const review = async (id: string) => (await rig.app.inject({ method: "GET", url: `/verifier/reports/${id}`, headers: rig.as(verifier.token) })).json();
const checked = (overrides: Record<string, object> = {}) =>
  facilities(overrides).map((f) => ({ reason: null, note: null, evidence: "terbukti", ...f }));
const placeCount = async () => (await rig.db.select({ n: count() }).from(places))[0]!.n;

describe("publishing a new place (FR-32, FR-33)", () => {
  let id: string;
  let shown: string;
  let hidden: string;
  let placeId: string;

  it("creates the place with the checked answers and the computed status", async () => {
    [shown, hidden] = [await rig.uploadPhoto(reporter.token), await rig.uploadPhoto(reporter.token)];
    id = await rig.submit(reporter.token, { ...rig.newPlace(), photos: [{ id: shown, tag: "pintu_masuk" }, { id: hidden, tag: "lainnya" }] });
    const blur = [{ x: 0.2, y: 0.2, w: 0.3, h: 0.3 }];
    await rig.app.inject({ method: "PATCH", url: `/verifier/reports/${id}/photos/${shown}`, headers: rig.as(verifier.token), payload: { blur } });
    await rig.app.inject({ method: "PATCH", url: `/verifier/reports/${id}/photos/${hidden}`, headers: rig.as(verifier.token), payload: { hidden: true } });
    const original = rig.memory.files.get(`laporan/${shown}.webp`)!.data;
    const before = await placeCount();

    const res = await publish(id, {
      name: "Masjid Al-Ikhlas",
      category: "masjid",
      location: { lat: -6.5976, lng: 106.7991 },
      landmark: null,
      description: "Ramp di pintu utama.",
      note: "Ramp terlihat di foto 1",
      facilities: checked({
        ramp: { answer: "tersedia" },
        // Pelapor menjawab Tersedia, tetapi tidak ada foto toilet: tanpa bukti menjadi Belum tahu.
        toilet_difabel: { answer: "tersedia", evidence: "tanpa_bukti" },
        guiding_block: { answer: "tidak_tersedia", reason: "tidak_ada" },
        lift: { answer: "tidak_perlu", note: "Satu lantai" },
      }),
    });
    expect(res.statusCode).toBe(200);
    placeId = res.json().placeId;
    expect(res.json()).toEqual({ status: "diterbitkan", placeId });
    expect(await placeCount()).toBe(before + 1);

    const detail = (await rig.app.inject({ method: "GET", url: `/places/${placeId}` })).json();
    expect(detail).toMatchObject({
      name: "Masjid Al-Ikhlas",
      district: { slug: "bogor-tengah" },
      status: "sebagian",
      summary: { available: 1, relevant: 3, unknown: 1 },
      description: "Ramp di pintu utama.",
      lastVerifiedAt: rig.clock.now.toISOString(),
      facilities: expect.arrayContaining([
        { facility: "toilet_difabel", answer: "belum_tahu", reason: null, note: null },
        { facility: "guiding_block", answer: "tidak_tersedia", reason: "tidak_ada", note: null },
        { facility: "lift", answer: "tidak_perlu", reason: null, note: "Satu lantai" },
      ]),
      photos: [{ id: shown, url: `https://foto.contoh.id/lokasi/${placeId}/${shown}.webp`, alt: "Foto pintu masuk dan ramp, Masjid Al-Ikhlas", tag: "pintu_masuk" }],
    });
    const map = (await rig.app.inject({ method: "GET", url: "/places/map" })).json() as { features: { id: string }[] };
    expect(map.features.map((f) => f.id)).toContain(placeId);

    // Foto publik adalah versi yang dikaburkan; asli dan foto tersembunyi tidak tersisa (ADR-0037).
    const publicFile = rig.memory.files.get(`lokasi/${placeId}/${shown}.webp`)!.data;
    expect(Buffer.compare(Buffer.from(publicFile), (await blurPhoto(original, blur)).data)).toBe(0);
    expect(rig.memory.files.has(`laporan/${shown}.webp`)).toBe(false);
    expect(rig.memory.files.has(`laporan/${hidden}.webp`)).toBe(false);
    expect(await rig.db.select().from(photos).where(eq(photos.id, hidden))).toEqual([]);
    expect(await rig.db.select().from(photoDeletions)).toEqual([]);
  });

  it("records the decision, the audit entries, the email, and the status in Laporan saya", async () => {
    const [report] = await rig.db.select().from(reports).where(eq(reports.id, id));
    expect(report).toMatchObject({ status: "diterbitkan", placeId, reviewerId: verifier.user.id, reviewerNote: "Ramp terlihat di foto 1", decidedAt: rig.clock.now });
    const actions = (await rig.db.select({ entity: auditLog.entityType, action: auditLog.action, changes: auditLog.changes }).from(auditLog).where(eq(auditLog.actorId, verifier.user.id)).orderBy(auditLog.id)).filter(
      (e) => e.action !== "dimoderasi",
    );
    expect(actions.map((e) => `${e.entity}:${e.action}`)).toEqual(["lokasi:dibuat", "laporan:diterbitkan", "foto:diterbitkan", "foto:dihapus"]);
    expect(actions[0]!.changes).toMatchObject({ name: { sebelum: null, sesudah: "Masjid Al-Ikhlas" }, status: { sebelum: null, sesudah: "sebagian" }, laporan: id });
    expect(JSON.stringify(actions)).not.toContain("foto 1");
    expect(await rig.db.select().from(reportEmails).where(eq(reportEmails.reportId, id))).toEqual([]);
    const published = rig.sent.find((e) => e.subject === "Laporan Anda sudah terbit: Masjid Al-Ikhlas")!;
    expect(published.to).toBe("pelapor@contoh.id");
    expect(published.text).toContain(`https://akses-bogor.contoh.id/lokasi/${placeId}`);
    const mine = (await rig.app.inject({ method: "GET", url: "/me/reports", headers: rig.as(reporter.token) })).json().items as { id: string }[];
    expect(mine.find((r) => r.id === id)).toMatchObject({ status: "diterbitkan", placeId });
  });

  it("allows one decision only", async () => {
    const again = await publish(id, { name: "x", category: "masjid", location: { lat: -6.5976, lng: 106.7991 }, description: null, facilities: checked() });
    expect([again.statusCode, again.json().galat]).toEqual([409, "sudah_diputuskan"]);
  });
});

describe("publishing change reports (FR-27)", () => {
  it("updates the same place for Edit lokasi and audits only what changed", async () => {
    const placeId = await rig.placeId("Kampus contoh A");
    const id = await rig.submit(reporter.token, {
      kind: "perubahan",
      placeId,
      name: "Kampus contoh A",
      category: "kampus",
      location: { lat: -6.552, lng: 106.788 },
      facilities: facilities({ ramp: { answer: "tersedia" }, toilet_difabel: { answer: "tersedia" }, guiding_block: { answer: "tersedia" }, lift: { answer: "tidak_tersedia", reason: "rusak" } }),
    });
    const before = await placeCount();
    const res = await publish(id, {
      placeVersion: (await review(id)).place.version,
      name: "Kampus Contoh A",
      category: "kampus",
      location: { lat: -6.552, lng: 106.788 },
      landmark: "Gerbang utara, dekat halte",
      description: "Lift sedang rusak.",
      facilities: checked({ ramp: { answer: "tersedia" }, toilet_difabel: { answer: "tersedia" }, guiding_block: { answer: "tersedia" }, lift: { answer: "tidak_tersedia", reason: "rusak", note: "Sejak November" } }),
    });
    expect(res.json()).toEqual({ status: "diterbitkan", placeId });
    expect(await placeCount()).toBe(before);
    const [place] = await rig.db.select().from(places).where(eq(places.id, placeId));
    expect(place).toMatchObject({ name: "Kampus Contoh A", status: "sebagian", facilitiesAvailable: 3, lastVerifiedAt: rig.clock.now });
    const [entry] = await rig.db.select().from(auditLog).where(and(eq(auditLog.entityId, placeId), eq(auditLog.action, "diubah")));
    expect(Object.keys(entry!.changes as object).sort()).toEqual(["description", "facilities", "laporan", "name", "status"]);
  });

  it("keeps name, category, point, and landmark for Laporkan kekurangan", async () => {
    const placeId = await rig.placeId("Halte contoh");
    const id = await rig.submit(reporter.token, { kind: "kekurangan", placeId, facilities: facilities({ ramp: { answer: "tersedia" }, lift: { answer: "tidak_tersedia", reason: "rusak" } }) });
    const res = await publish(id, {
      placeVersion: (await review(id)).place.version,
      name: "Nama lain",
      category: "kampus",
      location: { lat: -6.6, lng: 106.8 },
      landmark: "Lain",
      description: "Lift rusak.",
      facilities: checked({ ramp: { answer: "tersedia" }, toilet_difabel: { answer: "tidak_perlu" }, guiding_block: { answer: "tidak_tersedia", reason: "tidak_sesuai" }, lift: { answer: "tidak_tersedia", reason: "rusak" } }),
    });
    expect(res.statusCode).toBe(200);
    const [place] = await rig.db.select().from(places).where(eq(places.id, placeId));
    expect(place).toMatchObject({ name: "Halte contoh", category: "halte", landmark: "Seberang gerbang barat Kebun Raya", description: "Lift rusak.", location: { x: 106.7942, y: -6.5958 } });
    const lift = await rig.db.select().from(placeFacilities).where(and(eq(placeFacilities.placeId, placeId), eq(placeFacilities.facility, "lift")));
    expect(lift[0]).toMatchObject({ answer: "tidak_tersedia", reason: "rusak" });
  });

  it("refuses a stale place version and leaves no public copies behind", async () => {
    const placeId = await rig.placeId("Rumah sakit contoh");
    const photo = await rig.uploadPhoto(reporter.token);
    const id = await rig.submit(reporter.token, { kind: "kekurangan", placeId, facilities: facilities(), photos: [{ id: photo, tag: "lift" }] });
    const res = await publish(id, { placeVersion: "2020-01-01T00:00:00.000Z", description: null, facilities: checked() });
    expect([res.statusCode, res.json().galat]).toEqual([409, "lokasi_berubah"]);
    expect([...rig.memory.files.keys()].filter((k) => k.includes(photo))).toEqual([`laporan/${photo}.webp`]);
    expect((await rig.db.select({ status: reports.status }).from(reports).where(eq(reports.id, id)))[0]!.status).toBe("menunggu");
  });
});

describe("publish validation", () => {
  it("needs a reason for every proven Tidak tersedia and the place fields for new places", async () => {
    const id = await rig.submit(reporter.token, rig.newPlace({ name: "Kampus contoh E" }));
    const base = { name: "Kampus contoh E", category: "kampus", location: { lat: -6.5976, lng: 106.7991 }, description: null };
    const noReason = await publish(id, { ...base, facilities: checked({ ramp: { answer: "tidak_tersedia" } }) });
    expect([noReason.statusCode, noReason.json().galat]).toEqual([400, "alasan_wajib"]);
    // Tanpa bukti tidak butuh alasan, karena jawabannya menjadi Belum tahu.
    const missing = await publish(id, { ...base, name: undefined, facilities: checked({ ramp: { answer: "tidak_tersedia", evidence: "tanpa_bukti" } }) });
    expect([missing.statusCode, missing.json().galat]).toEqual([400, "isian_wajib"]);
    const outside = await publish(id, { ...base, location: { lat: -6.5594, lng: 106.7258 }, facilities: checked() });
    expect([outside.statusCode, outside.json().galat]).toEqual([422, "di_luar_kota_bogor"]);
    expect((await publish(id, { ...base, facilities: checked() }, reporter.token)).statusCode).toBe(403);
  });

  it("does not publish when a photo cannot be copied", async () => {
    const photo = await rig.uploadPhoto(reporter.token);
    const id = await rig.submit(reporter.token, { ...rig.newPlace({ name: "Halte gagal contoh" }), photos: [{ id: photo, tag: "pintu_masuk" }] });
    const before = await placeCount();
    rig.memory.failing.put = true;
    const res = await publish(id, { name: "Halte gagal contoh", category: "halte", location: { lat: -6.5976, lng: 106.7991 }, description: null, facilities: checked() });
    rig.memory.failing.put = false;
    expect([res.statusCode, res.json().galat]).toEqual([502, "foto_gagal_diterbitkan"]);
    expect(await placeCount()).toBe(before);
    expect((await rig.db.select({ status: reports.status }).from(reports).where(eq(reports.id, id)))[0]!.status).toBe("menunggu");
    expect(rig.memory.files.has(`laporan/${photo}.webp`)).toBe(true);
  });
});
