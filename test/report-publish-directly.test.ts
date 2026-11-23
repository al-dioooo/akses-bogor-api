import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, count, desc, eq } from "drizzle-orm";
import { auditLog, places, reports } from "../src/db/schema.js";
import { facilities, verificationRig, type Rig } from "./helpers/verification.js";

// Terbit langsung dari Laporkan, khusus admin (ADR-0051).
let rig: Rig;
let admin: { token: string; user: { id: string } };
let verifier: { token: string };
let reporter: { token: string };

beforeAll(async () => {
  rig = await verificationRig();
  admin = await rig.verifier("admin@contoh.id", "Admin Kota", "admin");
  verifier = await rig.verifier("verifikator@contoh.id", "Vera");
  reporter = await rig.helpers.reporter("pelapor@contoh.id", "Warga");
}, 90_000);

afterAll(async () => {
  await rig.close();
});

const post = (token: string, payload: Record<string, unknown>) =>
  rig.app.inject({ method: "POST", url: "/reports", headers: rig.as(token), payload: { submissionKey: crypto.randomUUID(), facilities: facilities(), photos: [], ...payload } });
const reportCount = async () => (await rig.db.select({ n: count() }).from(reports))[0]!.n;
const direct = { publishDirectly: true, publishReason: "Saya cek sendiri di lokasi" };

describe("POST /reports with publishDirectly", () => {
  let placeId: string;

  it("is refused for verifiers and regular accounts, without creating a report", async () => {
    const before = await reportCount();
    for (const token of [reporter.token, verifier.token]) {
      const res = await post(token, { ...rig.newPlace(), ...direct });
      expect(res.statusCode).toBe(403);
      expect(res.json().galat).toBe("bukan_admin");
    }
    expect(await reportCount()).toBe(before);
  });

  it("needs a reason", async () => {
    expect((await post(admin.token, { ...rig.newPlace(), publishDirectly: true })).statusCode).toBe(400);
  });

  it("publishes the admin's own report at once, with an admin label and Belum tahu where a photo is missing", async () => {
    const photo = await rig.uploadPhoto(admin.token);
    const submissionKey = crypto.randomUUID();
    const payload = {
      submissionKey,
      ...rig.newPlace({ name: "Masjid langsung contoh" }),
      photos: [{ id: photo, tag: "pintu_masuk" }],
      facilities: facilities({ ramp: { answer: "tersedia" }, toilet_difabel: { answer: "tersedia" } }),
      ...direct,
    };
    const res = await post(admin.token, payload);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: "diterbitkan", downgraded: ["toilet_difabel"] });
    placeId = res.json().placeId;
    expect((await rig.app.inject({ method: "GET", url: `/places/${placeId}` })).json().verifiedBy).toBe("admin");
    const [entry] = await rig.db.select().from(auditLog).where(and(eq(auditLog.entityType, "laporan"), eq(auditLog.entityId, res.json().id))).orderBy(desc(auditLog.id));
    expect(entry).toMatchObject({ action: "terbit_langsung", changes: { alasan: "Saya cek sendiri di lokasi" } });

    // Kirim ulang dengan kunci draf yang sama mengembalikan laporan yang sama, tanpa laporan kedua.
    const before = await reportCount();
    const again = await post(admin.token, payload);
    expect(again.json()).toMatchObject({ id: res.json().id, status: "diterbitkan" });
    expect(await reportCount()).toBe(before);
  });

  it("counts the place's shown photos as evidence for a missing-facility report", async () => {
    const res = await post(admin.token, { kind: "kekurangan", placeId, facilities: facilities({ ramp: { answer: "tersedia" }, lift: { answer: "tidak_perlu" } }), ...direct });
    expect(res.statusCode).toBe(201);
    expect(res.json().downgraded).toEqual(["lift"]);
    const [row] = await rig.db.select({ name: places.name }).from(places).where(eq(places.id, placeId));
    expect(row!.name).toBe("Masjid langsung contoh");
  });

  it("leaves an admin report without the flag in the queue as usual", async () => {
    const res = await post(admin.token, rig.newPlace({ name: "Masjid antrean contoh", location: { lat: -6.5705, lng: 106.7645 } }));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: "menunggu", placeId: null });
    expect(res.json().downgraded).toBeUndefined();
  });
});
