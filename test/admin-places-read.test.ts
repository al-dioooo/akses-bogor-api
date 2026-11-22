import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { count, eq } from "drizzle-orm";
import { loadFacilities, parseFacilities } from "../src/contribute/facilities.js";
import { places } from "../src/db/schema.js";
import type { OverpassElement } from "../src/knowledge/osm.js";
import { facilities, verificationRig, type Rig } from "./helpers/verification.js";

// Route baca Kelola tempat (ADR-0050): daftar, detail, riwayat, dan kandidat OSM, khusus admin.
let rig: Rig;
let admin: { token: string };
let verifier: { token: string };
let reporter: { token: string };
let halteId: string;
let kampusId: string;
let allPlaces: number;

const elements: OverpassElement[] = [
  // Masjid di Bogor Barat tanpa lokasi AksesBogor di dekatnya.
  { type: "way", id: 2, center: { lat: -6.5705, lon: 106.7645 }, tags: { amenity: "place_of_worship", religion: "muslim", name: "Masjid Al-Ikhlas", wheelchair: "limited" } },
  // Rumah sakit tanpa nama, 60 m dari "Rumah sakit contoh".
  { type: "node", id: 3, lat: -6.5705, lon: 106.764, tags: { amenity: "hospital" } },
  // Halte 20 m dari "Halte contoh": sudah punya data AksesBogor.
  { type: "node", id: 1, lat: -6.5959, lon: 106.7943, tags: { highway: "bus_stop", name: "Halte Pajajaran" } },
];

beforeAll(async () => {
  rig = await verificationRig();
  admin = await rig.verifier("admin@contoh.id", "Admin Kota", "admin");
  verifier = await rig.verifier("verifikator@contoh.id", "Vera");
  reporter = await rig.helpers.reporter("pelapor@contoh.id", "Warga");
  halteId = await rig.placeId("Halte contoh");
  kampusId = await rig.placeId("Kampus contoh A");
  allPlaces = (await rig.db.select({ n: count() }).from(places))[0]!.n;
  await loadFacilities(rig.db, parseFacilities({ elements }), { url: "https://overpass-api.de/api/interpreter", retrievedAt: rig.clock.now, sha256: "e".repeat(64) });
  await rig.db.update(places).set({ adminPublishedAt: rig.clock.now }).where(eq(places.id, kampusId));

  // Satu laporan kekurangan yang diterbitkan verifikator menulis riwayat Halte contoh.
  const reportId = await rig.submit(reporter.token, { kind: "kekurangan", placeId: halteId, photos: [] });
  const version = (await rig.db.select({ updatedAt: places.updatedAt }).from(places).where(eq(places.id, halteId)))[0]!.updatedAt.toISOString();
  const published = await rig.app.inject({
    method: "POST",
    url: `/verifier/reports/${reportId}/publish`,
    headers: rig.as(verifier.token),
    payload: { placeVersion: version, description: null, facilities: facilities({ lift: { answer: "tidak_perlu" } }).map((f) => ({ reason: null, note: null, evidence: "terbukti", ...f })) },
  });
  expect(published.statusCode).toBe(200);
  await rig.db.update(places).set({ unpublishedAt: rig.clock.now, unpublishedReason: "Halte sudah dibongkar" }).where(eq(places.id, halteId));
}, 90_000);

afterAll(async () => {
  await rig.close();
});

const get = async (url: string, token = admin.token) => {
  const res = await rig.app.inject({ method: "GET", url, headers: rig.as(token) });
  return { status: res.statusCode, body: res.json() };
};

describe("access", () => {
  const urls = () => ["/admin/places", `/admin/places/${halteId}`, `/admin/places/${halteId}/history`, "/admin/candidates"];

  it("asks for a session", async () => {
    for (const url of urls()) expect((await rig.app.inject({ method: "GET", url })).statusCode).toBe(401);
  });

  it("is for admins only, not for verifiers or regular accounts", async () => {
    for (const url of urls()) {
      expect((await get(url, verifier.token)).status).toBe(403);
      expect((await get(url, reporter.token)).status).toBe(403);
    }
  });
});

describe("GET /admin/places", () => {
  it("lists every place, including unpublished ones with their reason", async () => {
    const { status, body } = await get("/admin/places");
    expect(status).toBe(200);
    expect(body.total).toBe(allPlaces);
    const halte = body.items.find((p: { id: string }) => p.id === halteId);
    expect(halte).toMatchObject({ published: false, unpublishedReason: "Halte sudah dibongkar", verifiedBy: "tim" });
  });

  it("filters by published state, origin, name, category, kecamatan and status", async () => {
    const ids = async (query: string) => (await get(`/admin/places?${query}`)).body.items.map((p: { id: string }) => p.id);
    expect(await ids("published=tidak")).toEqual([halteId]);
    expect(await ids("published=ya")).not.toContain(halteId);
    expect(await ids("origin=admin")).toEqual([kampusId]);
    expect(await ids("q=kampus%20contoh")).toContain(kampusId);
    expect(await ids("category=halte")).toContain(halteId);
    expect(await ids("category=halte&published=ya")).not.toContain(halteId);
    const [kampus] = (await get(`/admin/places?q=Kampus%20contoh%20A`)).body.items;
    expect(await ids(`district=${kampus.district.slug}&status=${kampus.status}`)).toContain(kampusId);
  });

  it("pages through the list", async () => {
    const first = (await get("/admin/places?limit=2")).body;
    const second = (await get("/admin/places?limit=2&offset=2")).body;
    expect(first.items).toHaveLength(2);
    expect(second.offset).toBe(2);
    expect(second.items[0].id).not.toBe(first.items[1].id);
    expect((await get("/admin/places?limit=101")).status).toBe(400);
  });
});

describe("GET /admin/places/:id", () => {
  it("returns the full place with its answers and version, also when unpublished", async () => {
    const { status, body } = await get(`/admin/places/${halteId}`);
    expect(status).toBe(200);
    expect(body.facilities.map((f: { facility: string }) => f.facility).sort()).toEqual(["guiding_block", "lift", "ramp", "toilet_difabel"]);
    expect(body.facilities.find((f: { facility: string }) => f.facility === "lift").answer).toBe("tidak_perlu");
    expect(body).toMatchObject({ published: false, adminPublishedBy: null, photos: [] });
    expect(body.version).toBe(body.updatedAt);
    expect(body.location).toEqual({ lat: expect.any(Number), lng: expect.any(Number) });
  });

  it("answers 404 for an unknown place", async () => {
    expect((await get(`/admin/places/${crypto.randomUUID()}`)).status).toBe(404);
  });
});

describe("GET /admin/places/:id/history", () => {
  it("shows who changed the place, when, and from which report", async () => {
    const { status, body } = await get(`/admin/places/${halteId}/history`);
    expect(status).toBe(200);
    const [entry] = body.items;
    expect(entry).toMatchObject({ action: "diubah", actor: { name: "Vera", label: null } });
    expect(entry.changes.laporan).toEqual(expect.any(String));
    expect(JSON.stringify(body)).not.toContain("pelapor@contoh.id");
  });
});

describe("GET /admin/candidates", () => {
  it("lists OpenStreetMap places without AksesBogor data, with the wheelchair tag as it is", async () => {
    const { status, body } = await get("/admin/candidates");
    expect(status).toBe(200);
    // Bernama dulu, urut nama; Halte Pajajaran ikut karena Halte contoh di dekatnya sudah diturunkan.
    expect(body.items.map((c: { osmId: number }) => c.osmId)).toEqual([1, 2, 3]);
    expect(body.items[1]).toMatchObject({ osmType: "way", name: "Masjid Al-Ikhlas", category: "masjid", wheelchair: "limited" });
    expect(body).toMatchObject({ total: 3, attribution: "© kontributor OpenStreetMap" });
    expect((await get("/admin/candidates?category=rumah_sakit")).body.items.map((c: { osmId: number }) => c.osmId)).toEqual([3]);
  });

  it("shows a candidate again once the nearby place is unpublished", async () => {
    // Halte contoh sudah diturunkan, jadi Halte Pajajaran 20 m darinya kembali menjadi kandidat.
    expect((await get("/admin/candidates?category=halte")).body.items.map((c: { osmId: number }) => c.osmId)).toEqual([1]);
  });
});
