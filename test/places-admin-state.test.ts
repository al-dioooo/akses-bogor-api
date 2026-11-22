import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { places } from "../src/db/schema.js";
import { placesNamed } from "../src/places/queries.js";
import { facilities, verificationRig, type Rig } from "./helpers/verification.js";

// Lokasi yang diturunkan admin dan lokasi yang diterbitkan langsung oleh admin (ADR-0050), dilihat dari route publik.
let rig: Rig;
let halteId: string;
let kampusId: string;

beforeAll(async () => {
  rig = await verificationRig();
  halteId = await rig.placeId("Halte contoh");
  kampusId = await rig.placeId("Kampus contoh A");
  await rig.db.update(places).set({ unpublishedAt: rig.clock.now, unpublishedReason: "Halte sudah dibongkar" }).where(eq(places.id, halteId));
  await rig.db.update(places).set({ adminPublishedAt: rig.clock.now, lastVerifiedAt: rig.clock.now }).where(eq(places.id, kampusId));
}, 90_000);

afterAll(async () => {
  await rig.close();
});

const get = async (url: string) => {
  const res = await rig.app.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.json() };
};

describe("an unpublished place", () => {
  it("is left out of the list, the map and its own page", async () => {
    const list = await get("/places?limit=50");
    expect(list.body.items.map((p: { id: string }) => p.id)).not.toContain(halteId);
    expect(list.body.total).toBe(list.body.items.length);
    const map = await get("/places/map");
    expect(map.body.features.map((f: { id: string }) => f.id)).not.toContain(halteId);
    expect((await get(`/places/${halteId}`)).status).toBe(404);
  });

  it("is not counted in the stats or the kecamatan counts", async () => {
    const stats = await get("/places/stats");
    expect(stats.body.places).toBe((await get("/places?limit=50")).body.total);
    const districts = await get("/districts");
    const total = districts.body.reduce((sum: number, d: { places: number }) => sum + d.places, 0);
    expect(total).toBe(stats.body.places);
  });

  it("is not offered as a similar place nearby or by name", async () => {
    const [row] = await rig.db.select({ name: places.name, location: places.location }).from(places).where(eq(places.id, halteId));
    const res = await rig.app.inject({
      method: "POST",
      url: "/reports/location-check",
      payload: { location: { lat: row!.location.y, lng: row!.location.x }, name: row!.name },
    });
    expect(res.json().nearby.map((p: { id: string }) => p.id)).not.toContain(halteId);
    expect((await placesNamed(rig.db, row!.name)).map((p) => p.id)).not.toContain(halteId);
  });

  it("takes no new reports, and a waiting report about it cannot be published", async () => {
    const reporter = await rig.helpers.reporter("pelapor-turun@contoh.id", "Warga");
    const res = await rig.app.inject({
      method: "POST",
      url: "/reports",
      headers: rig.as(reporter.token),
      payload: { submissionKey: crypto.randomUUID(), kind: "kekurangan", placeId: halteId, facilities: facilities(), photos: [] },
    });
    expect(res.statusCode).toBe(404);

    // Laporan yang sudah menunggu sebelum lokasinya diturunkan.
    await rig.db.update(places).set({ unpublishedAt: null, unpublishedReason: null }).where(eq(places.id, halteId));
    const reportId = await rig.submit(reporter.token, { kind: "kekurangan", placeId: halteId, photos: [] });
    const version = (await rig.db.select({ updatedAt: places.updatedAt }).from(places).where(eq(places.id, halteId)))[0]!.updatedAt.toISOString();
    await rig.db.update(places).set({ unpublishedAt: rig.clock.now, unpublishedReason: "Halte sudah dibongkar" }).where(eq(places.id, halteId));
    const verifier = await rig.verifier("verifikator-turun@contoh.id");
    const publish = await rig.app.inject({
      method: "POST",
      url: `/verifier/reports/${reportId}/publish`,
      headers: rig.as(verifier.token),
      payload: { placeVersion: version, description: null, facilities: facilities().map((f) => ({ ...f, reason: null, note: null, evidence: "terbukti" })) },
    });
    expect(publish.statusCode).toBe(409);
    expect(publish.json().galat).toBe("lokasi_diturunkan");
  });
});

describe("a place published directly by an admin", () => {
  it("says so in the list and on its page, and other places stay verified by the team", async () => {
    const list = await get("/places?limit=50");
    const by = Object.fromEntries(list.body.items.map((p: { id: string; verifiedBy: string }) => [p.id, p.verifiedBy]));
    expect(by[kampusId]).toBe("admin");
    expect(Object.values(by).filter((v) => v === "tim").length).toBe(list.body.items.length - 1);
    expect((await get(`/places/${kampusId}`)).body.verifiedBy).toBe("admin");
  });

  it("goes back to verified by the team once a verifier publishes a report about it", async () => {
    const reporter = await rig.helpers.reporter("pelapor-admin@contoh.id", "Warga");
    const verifier = await rig.verifier("verifikator-admin@contoh.id");
    const reportId = await rig.submit(reporter.token, { kind: "kekurangan", placeId: kampusId, photos: [] });
    const version = (await rig.db.select({ updatedAt: places.updatedAt }).from(places).where(eq(places.id, kampusId)))[0]!.updatedAt.toISOString();
    const publish = await rig.app.inject({
      method: "POST",
      url: `/verifier/reports/${reportId}/publish`,
      headers: rig.as(verifier.token),
      payload: { placeVersion: version, description: null, facilities: facilities().map((f) => ({ ...f, reason: null, note: null, evidence: "terbukti" })) },
    });
    expect(publish.statusCode).toBe(200);
    expect((await get(`/places/${kampusId}`)).body.verifiedBy).toBe("tim");
    const [row] = await rig.db.select({ by: places.adminPublishedBy, at: places.adminPublishedAt }).from(places).where(eq(places.id, kampusId));
    expect(row).toEqual({ by: null, at: null });
  });
});
