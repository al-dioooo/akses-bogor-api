import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { auditLog, photos, reports } from "../src/db/schema.js";
import { blurPhoto, toPixels } from "../src/photos/blur.js";
import { verificationRig, type Rig } from "./helpers/verification.js";

let rig: Rig;
let reporter: { token: string; user: { id: string } };
let verifier: { token: string; user: { id: string } };
let reportId: string;
let photoId: string;
let secondPhoto: string;

beforeAll(async () => {
  rig = await verificationRig();
  reporter = await rig.helpers.reporter("pelapor@contoh.id", "Warga Bogor");
  verifier = await rig.verifier("verifikator@contoh.id");
  [photoId, secondPhoto] = [await rig.uploadPhoto(reporter.token), await rig.uploadPhoto(reporter.token)];
  reportId = await rig.submit(reporter.token, {
    ...rig.newPlace(),
    photos: [
      { id: photoId, tag: "lainnya" },
      { id: secondPhoto, tag: "lift" },
    ],
  });
}, 90_000);

afterAll(async () => {
  await rig.close();
});

/** Simpangan baku kanal pertama di area tertentu. `stats()` mengabaikan `extract`, jadi area dipotong dulu. */
const spread = async (image: Uint8Array, area: { left: number; top: number; width: number; height: number }) =>
  (await sharp(await sharp(image).extract(area).png().toBuffer()).stats()).channels[0]!.stdev;

describe("blurPhoto (ADR-0037)", () => {
  it("destroys detail inside each area and leaves the rest of the photo alone", async () => {
    const noisy = await sharp({ create: { width: 200, height: 100, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 60 } } })
      .webp({ quality: 90 })
      .toBuffer();
    const result = await blurPhoto(noisy, [{ x: 0.5, y: 0.2, w: 0.4, h: 0.6 }]);
    expect(result).toMatchObject({ width: 200, height: 100, contentType: "image/webp" });
    const inside = { left: 110, top: 30, width: 60, height: 40 };
    const outside = { left: 5, top: 5, width: 60, height: 40 };
    expect(await spread(result.data, inside)).toBeLessThan((await spread(noisy, inside)) * 0.3);
    expect(await spread(result.data, outside)).toBeGreaterThan((await spread(noisy, outside)) * 0.8);
    expect((await sharp(result.data).metadata()).exif).toBeUndefined();
  });

  it("rounds areas outward and keeps them inside the photo", () => {
    expect(toPixels({ x: 0.1, y: 0.1, w: 0.25, h: 0.5 }, 99, 99)).toEqual({ left: 9, top: 9, width: 26, height: 51 });
    expect(toPixels({ x: 0.95, y: 0.99, w: 0.05, h: 0.01 }, 100, 100)).toEqual({ left: 95, top: 99, width: 5, height: 1 });
  });
});

const photoUrl = (id: string, query = "") => ({ method: "GET" as const, url: `/verifier/photos/${id}${query}` });

describe("GET /verifier/photos/:id", () => {
  it("serves the private photo to verifiers without caching", async () => {
    const res = await rig.app.inject({ ...photoUrl(photoId), headers: rig.as(verifier.token) });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/webp");
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(Buffer.compare(res.rawPayload, Buffer.from(rig.memory.files.get(`laporan/${photoId}.webp`)!.data))).toBe(0);
  });

  it("is closed to reporters, to the reporter's own verifier account, and to unknown photos", async () => {
    expect((await rig.app.inject(photoUrl(photoId))).statusCode).toBe(401);
    expect((await rig.app.inject({ ...photoUrl(photoId), headers: rig.as(reporter.token) })).statusCode).toBe(403);
    const reportingVerifier = await rig.verifier("verifikator-pelapor@contoh.id");
    const own = await rig.uploadPhoto(reportingVerifier.token);
    await rig.submit(reportingVerifier.token, { ...rig.newPlace({ name: "Halte baru contoh" }), photos: [{ id: own, tag: "lainnya" }] });
    const res = await rig.app.inject({ ...photoUrl(own), headers: rig.as(reportingVerifier.token) });
    expect([res.statusCode, res.json().galat]).toEqual([403, "laporan_sendiri"]);
    const missing = await rig.app.inject({ ...photoUrl(crypto.randomUUID()), headers: rig.as(verifier.token) });
    expect([missing.statusCode, missing.json().galat]).toEqual([404, "foto_tidak_ditemukan"]);
  });

  it("answers 502 when storage cannot be read", async () => {
    rig.memory.failing.get = true;
    const res = await rig.app.inject({ ...photoUrl(photoId), headers: rig.as(verifier.token) });
    rig.memory.failing.get = false;
    expect([res.statusCode, res.json().galat]).toEqual([502, "foto_gagal_dibaca"]);
  });
});

const moderate = (token: string, body: object, photo = photoId, report = reportId) =>
  rig.app.inject({ method: "PATCH", url: `/verifier/reports/${report}/photos/${photo}`, headers: rig.as(token), payload: body });

describe("PATCH /verifier/reports/:id/photos/:photoId (FR-34)", () => {
  it("saves tag, caption, hiding, and blur areas, and audits them without the caption text", async () => {
    const blur = [{ x: 0.1, y: 0.1, w: 0.3, h: 0.2 }];
    const res = await moderate(verifier.token, { tag: "pintu_masuk", caption: "Ramp dari parkir", blur });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: photoId, tag: "pintu_masuk", caption: "Ramp dari parkir", hidden: false, blur });
    expect((await moderate(verifier.token, { hidden: true }, secondPhoto)).json()).toMatchObject({ hidden: true });

    const entries = await rig.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "foto"), eq(auditLog.action, "dimoderasi")))
      .orderBy(auditLog.id);
    expect(entries.map((e) => e.changes)).toEqual([
      { tag: { sebelum: "lainnya", sesudah: "pintu_masuk" }, areaKabur: { sebelum: 0, sesudah: 1 }, laporan: reportId },
      { disembunyikan: { sebelum: false, sesudah: true }, laporan: reportId },
    ]);
    expect(JSON.stringify(entries)).not.toContain("Ramp dari parkir");
  });

  it("serves the blurred preview exactly as it will be published", async () => {
    const preview = await rig.app.inject({ ...photoUrl(photoId, "?versi=kabur"), headers: rig.as(verifier.token) });
    const original = rig.memory.files.get(`laporan/${photoId}.webp`)!.data;
    const expected = await blurPhoto(original, [{ x: 0.1, y: 0.1, w: 0.3, h: 0.2 }]);
    expect(Buffer.compare(preview.rawPayload, expected.data)).toBe(0);
  });

  it("rejects areas outside the photo, empty changes, and photos of other reports", async () => {
    expect((await moderate(verifier.token, { blur: [{ x: 0.8, y: 0, w: 0.3, h: 0.1 }] })).statusCode).toBe(400);
    expect((await moderate(verifier.token, {})).statusCode).toBe(400);
    const other = await rig.submit(reporter.token, rig.newPlace({ name: "Masjid lain contoh" }));
    const res = await moderate(verifier.token, { hidden: true }, photoId, other);
    expect([res.statusCode, res.json().galat]).toEqual([404, "foto_tidak_ditemukan"]);
  });

  it("refuses changes once the report is decided", async () => {
    await rig.db.update(reports).set({ status: "ditolak", rejectionReason: "duplikat" }).where(eq(reports.id, reportId));
    const res = await moderate(verifier.token, { hidden: false });
    expect([res.statusCode, res.json().galat]).toEqual([409, "sudah_diputuskan"]);
    const [row] = await rig.db.select({ moderation: photos.moderation }).from(photos).where(eq(photos.id, photoId));
    expect(row!.moderation).toBe("menunggu");
  });
});
