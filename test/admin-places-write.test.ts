import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, count, desc, eq } from "drizzle-orm";
import { directAnswers } from "../src/admin/edit.js";
import { auditLog, photoDeletions, photos, placeFacilities, places, reportEmails, reports } from "../src/db/schema.js";
import { facilities, verificationRig, type Rig } from "./helpers/verification.js";

// Tambah, ubah, turunkan, dan tayangkan lagi tempat oleh admin (ADR-0051).
let rig: Rig;
let admin: { token: string; user: { id: string } };
let verifier: { token: string };

beforeAll(async () => {
  rig = await verificationRig();
  admin = await rig.verifier("admin@contoh.id", "Admin Kota", "admin");
  verifier = await rig.verifier("verifikator@contoh.id", "Vera");
}, 90_000);

afterAll(async () => {
  await rig.close();
});

const send = (method: "POST" | "PATCH" | "DELETE", url: string, payload: object, token = admin.token) =>
  rig.app.inject({ method, url, headers: rig.as(token), payload });
const reportCount = async () => (await rig.db.select({ n: count() }).from(reports))[0]!.n;
const lastAudit = async (entityId: string) =>
  (await rig.db.select().from(auditLog).where(and(eq(auditLog.entityType, "lokasi"), eq(auditLog.entityId, entityId))).orderBy(desc(auditLog.id)).limit(1))[0]!;
const answersOf = async (placeId: string) =>
  Object.fromEntries((await rig.db.select().from(placeFacilities).where(eq(placeFacilities.placeId, placeId))).map((f) => [f.facility, f.answer]));
const versionOf = async (placeId: string) => (await rig.db.select({ v: places.updatedAt }).from(places).where(eq(places.id, placeId)))[0]!.v.toISOString();

const newPlace = (extra: Record<string, unknown> = {}) => ({
  name: "Masjid Raya contoh",
  category: "masjid",
  location: { lat: -6.5976, lng: 106.7991 },
  facilities: facilities(),
  photos: [],
  reason: "Dicek langsung saat survei tim",
  ...extra,
});

describe("directAnswers", () => {
  it("keeps Tersedia and Tidak perlu only with a photo of that facility", () => {
    const { final, downgraded } = directAnswers(
      [
        { facility: "ramp", answer: "tersedia" },
        { facility: "toilet_difabel", answer: "tersedia" },
        { facility: "guiding_block", answer: "tidak_tersedia", reason: "rusak" },
        { facility: "lift", answer: "tidak_perlu" },
      ],
      ["pintu_masuk", "lainnya"],
    );
    expect(final.map((f) => [f.facility, f.evidence])).toEqual([
      ["ramp", "terbukti"],
      ["toilet_difabel", "tanpa_bukti"],
      ["guiding_block", "terbukti"],
      ["lift", "tanpa_bukti"],
    ]);
    expect(downgraded).toEqual(["toilet_difabel", "lift"]);
  });
});

describe("POST /admin/places", () => {
  let placeId: string;

  it("is for admins only", async () => {
    expect((await rig.app.inject({ method: "POST", url: "/admin/places", payload: newPlace() })).statusCode).toBe(401);
    expect((await send("POST", "/admin/places", newPlace(), verifier.token)).statusCode).toBe(403);
  });

  it("publishes the place at once with an admin label, the photo, and Belum tahu for answers without a photo", async () => {
    const photo = await rig.uploadPhoto(admin.token);
    const res = await send(
      "POST",
      "/admin/places",
      newPlace({
        photos: [{ id: photo, tag: "pintu_masuk" }],
        facilities: facilities({ ramp: { answer: "tersedia" }, toilet_difabel: { answer: "tersedia" }, guiding_block: { answer: "tidak_tersedia", reason: "tidak_ada" } }),
        osm: { type: "way", id: 2 },
      }),
    );
    expect(res.statusCode).toBe(201);
    placeId = res.json().placeId;
    expect(res.json().downgraded).toEqual(["toilet_difabel"]);
    expect(await answersOf(placeId)).toMatchObject({ ramp: "tersedia", toilet_difabel: "belum_tahu", guiding_block: "tidak_tersedia" });

    const page = (await rig.app.inject({ method: "GET", url: `/places/${placeId}` })).json();
    expect(page).toMatchObject({ verifiedBy: "admin", lastVerifiedAt: rig.clock.now.toISOString() });
    expect(page.photos).toHaveLength(1);
    expect(rig.memory.files.has(`lokasi/${placeId}/${photo}.webp`)).toBe(true);

    const entry = await lastAudit(placeId);
    expect(entry).toMatchObject({ action: "dibuat_admin", actorId: admin.user.id });
    expect(entry.changes).toMatchObject({ alasan: "Dicek langsung saat survei tim", osm: { type: "way", id: 2 } });
    const [report] = await rig.db.select().from(reports).where(eq(reports.placeId, placeId));
    expect(report).toMatchObject({ status: "diterbitkan", reporterId: admin.user.id, reviewerId: admin.user.id });
    expect(await rig.db.select().from(reportEmails).where(eq(reportEmails.reportId, report!.id))).toEqual([]);
  });

  it("refuses Tidak tersedia without a reason, a short reason, and a pin outside Kota Bogor, leaving no report behind", async () => {
    const before = await reportCount();
    const noReason = await send("POST", "/admin/places", newPlace({ facilities: facilities({ lift: { answer: "tidak_tersedia" } }) }));
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().galat).toBe("alasan_wajib");
    expect((await send("POST", "/admin/places", newPlace({ reason: "ok" }))).statusCode).toBe(400);
    expect((await send("POST", "/admin/places", newPlace({ location: { lat: -6.2, lng: 106.82 } }))).statusCode).toBe(422);
    expect(await reportCount()).toBe(before);
  });

  it("gives the photos back and removes the report when publishing fails", async () => {
    const photo = await rig.uploadPhoto(admin.token);
    const before = await reportCount();
    rig.memory.failing.put = true;
    const res = await send("POST", "/admin/places", newPlace({ name: "Masjid gagal", photos: [{ id: photo, tag: "pintu_masuk" }] }));
    rig.memory.failing.put = false;
    expect(res.statusCode).toBe(502);
    expect(await reportCount()).toBe(before);
    const [row] = await rig.db.select({ reportId: photos.reportId, uploaderId: photos.uploaderId }).from(photos).where(eq(photos.id, photo));
    expect(row).toEqual({ reportId: null, uploaderId: admin.user.id });
  });

  describe("PATCH /admin/places/:id", () => {
    it("changes the place, keeps the shown photo as evidence, and can delete a photo", async () => {
      const [shown] = await rig.db.select({ id: photos.id, key: photos.storageKey }).from(photos).where(eq(photos.placeId, placeId));
      const second = await rig.uploadPhoto(admin.token);
      const res = await send("PATCH", `/admin/places/${placeId}`, {
        ...newPlace({ name: "Masjid Raya Bogor contoh", reason: "Nama resmi dari papan nama" }),
        facilities: facilities({ ramp: { answer: "tersedia" }, lift: { answer: "tidak_perlu" } }),
        photos: [{ id: second, tag: "lift" }],
        version: await versionOf(placeId),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().downgraded).toEqual([]);
      expect(await answersOf(placeId)).toMatchObject({ ramp: "tersedia", lift: "tidak_perlu" });
      expect((await lastAudit(placeId)).action).toBe("diubah_admin");

      const removal = await send("PATCH", `/admin/places/${placeId}`, {
        ...newPlace({ name: "Masjid Raya Bogor contoh", reason: "Foto pintu masuk memperlihatkan wajah" }),
        facilities: facilities({ ramp: { answer: "tersedia" } }),
        removePhotos: [shown!.id],
        version: await versionOf(placeId),
      });
      expect(removal.statusCode).toBe(200);
      // Tanpa foto pintu masuk, ramp tidak lagi punya bukti.
      expect(removal.json().downgraded).toEqual(["ramp"]);
      expect(await rig.db.select().from(photos).where(eq(photos.id, shown!.id))).toEqual([]);
      expect(rig.memory.files.has(shown!.key)).toBe(false);
      expect(await rig.db.select().from(photoDeletions).where(eq(photoDeletions.storageKey, shown!.key))).toEqual([]);
    });

    it("refuses an old version, a photo of another place, and an unknown place", async () => {
      const stale = await send("PATCH", `/admin/places/${placeId}`, { ...newPlace(), version: "2020-01-01T00:00:00.000Z" });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().galat).toBe("lokasi_berubah");
      const foreign = await send("PATCH", `/admin/places/${placeId}`, { ...newPlace(), version: await versionOf(placeId), removePhotos: [crypto.randomUUID()] });
      expect(foreign.statusCode).toBe(400);
      expect((await send("PATCH", `/admin/places/${crypto.randomUUID()}`, { ...newPlace(), version: await versionOf(placeId) })).statusCode).toBe(404);
    });

    it("turns a place verified by the team into an admin place", async () => {
      const halteId = await rig.placeId("Halte contoh");
      const res = await send("PATCH", `/admin/places/${halteId}`, { ...newPlace({ name: "Halte contoh", category: "halte", location: { lat: -6.5958, lng: 106.7942 } }), version: await versionOf(halteId) });
      expect(res.statusCode).toBe(200);
      expect((await rig.app.inject({ method: "GET", url: `/places/${halteId}` })).json().verifiedBy).toBe("admin");
    });
  });

  describe("DELETE and restore", () => {
    it("takes the place down with a reason and shows it again later", async () => {
      const down = await send("DELETE", `/admin/places/${placeId}`, { reason: "Masjid sedang dibangun ulang" });
      expect(down.statusCode).toBe(204);
      expect((await rig.app.inject({ method: "GET", url: `/places/${placeId}` })).statusCode).toBe(404);
      expect(await lastAudit(placeId)).toMatchObject({ action: "diturunkan", changes: { alasan: "Masjid sedang dibangun ulang" } });
      expect((await send("DELETE", `/admin/places/${placeId}`, { reason: "Masjid sedang dibangun ulang" })).statusCode).toBe(409);

      const patch = await send("PATCH", `/admin/places/${placeId}`, { ...newPlace(), version: await versionOf(placeId) });
      expect(patch.json().galat).toBe("lokasi_diturunkan");

      const up = await send("POST", `/admin/places/${placeId}/restore`, { reason: "Pembangunan selesai" });
      expect(up.statusCode).toBe(204);
      expect((await rig.app.inject({ method: "GET", url: `/places/${placeId}` })).statusCode).toBe(200);
      expect(await lastAudit(placeId)).toMatchObject({ action: "ditayangkan_lagi", changes: { alasan: "Pembangunan selesai", alasanTurun: "Masjid sedang dibangun ulang" } });
      expect((await send("POST", `/admin/places/${placeId}/restore`, { reason: "Pembangunan selesai" })).statusCode).toBe(409);
    });

    it("is for admins only and needs a reason", async () => {
      expect((await send("DELETE", `/admin/places/${placeId}`, { reason: "Tidak sesuai" }, verifier.token)).statusCode).toBe(403);
      expect((await send("DELETE", `/admin/places/${placeId}`, {})).statusCode).toBe(400);
    });
  });
});
