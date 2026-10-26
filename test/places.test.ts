import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { photos, places, reports, users } from "../src/db/schema.js";
import { seedSampleData } from "../src/db/seed.js";
import { createTestDb } from "./helpers/db.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let close: () => Promise<void>;
let halteId: string;
let halteBId: string;

beforeAll(async () => {
  const test = await createTestDb();
  close = test.close;
  const db = test.db;
  await seedSampleData(db);
  const byName = async (name: string) => (await db.select({ id: places.id }).from(places).where(eq(places.name, name)))[0]!.id;
  halteId = await byName("Halte contoh");
  halteBId = await byName("Halte contoh B");
  // One published report with photos for the Halte contoh: two shown, one hidden by moderation.
  const [user] = await db.insert(users).values({ displayName: "Sari", email: "sari@contoh.id" }).returning({ id: users.id });
  const [report] = await db
    .insert(reports)
    .values({ kind: "baru", placeId: halteId, status: "diterbitkan", submission: {}, reporterId: user!.id })
    .returning({ id: reports.id });
  const photo = (key: string, tag: "pintu_masuk" | "lainnya", moderation: "tayang" | "disembunyikan") => ({
    reportId: report!.id, placeId: halteId, storageKey: key, tag, moderation, altText: `Foto ${tag}, Halte contoh`, width: 2048, height: 1536, bytes: 400_000,
  });
  await db.insert(photos).values([
    photo("laporan/halte/lainnya.jpg", "lainnya", "tayang"),
    photo("laporan/halte/pintu masuk.jpg", "pintu_masuk", "tayang"),
    photo("laporan/halte/wajah.jpg", "pintu_masuk", "disembunyikan"),
  ]);
  const env = loadEnv({ NODE_ENV: "test", DATABASE_URL: "postgresql://test@localhost/test", PHOTO_PUBLIC_URL: "https://foto.aksesbogor.id/" });
  app = await buildApp(env, { db, now: () => new Date("2026-10-26T00:00:00Z") });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await close();
});

const get = async (url: string) => {
  const res = await app.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.json() };
};
const names = (body: { items: { name: string }[] }) => body.items.map((i) => i.name);

describe("GET /districts", () => {
  it("lists the six kecamatan with their place counts", async () => {
    const { status, body } = await get("/districts");
    expect(status).toBe(200);
    expect(body.map((d: { slug: string; places: number }) => [d.slug, d.places])).toEqual([
      ["bogor-barat", 1], ["bogor-selatan", 1], ["bogor-tengah", 1], ["bogor-timur", 1], ["bogor-utara", 1], ["tanah-sareal", 2],
    ]);
  });
});

describe("GET /places", () => {
  it("lists every place by name with summary, location, and cover photo", async () => {
    const { status, body } = await get("/places");
    expect(status).toBe(200);
    expect(body.total).toBe(7);
    expect(names(body)).toEqual(["Halte contoh", "Halte contoh B", "Kampus contoh A", "Kampus contoh B", "Masjid contoh A", "Masjid contoh B", "Rumah sakit contoh"]);
    expect(body.items[0]).toMatchObject({
      status: "sebagian",
      district: { slug: "bogor-tengah", name: "Bogor Tengah" },
      summary: { available: 2, relevant: 3, unknown: 0 },
      location: { lat: -6.5958, lng: 106.7942 },
      coverPhoto: { tag: "pintu_masuk", url: "https://foto.aksesbogor.id/laporan/halte/pintu%20masuk.jpg" },
    });
    expect(body.items[1].coverPhoto).toBeNull();
  });

  it("matches part of a name without caring about case (FR-02)", async () => {
    expect(names((await get("/places?q=kampus")).body)).toEqual(["Kampus contoh A", "Kampus contoh B"]);
    expect(names((await get("/places?q=CONTOH%20B")).body)).toEqual(["Halte contoh B", "Kampus contoh B", "Masjid contoh B"]);
  });

  it("treats LIKE wildcards in the search as plain text", async () => {
    expect((await get("/places?q=%25")).body.total).toBe(0);
  });

  it("filters by category, kecamatan, and status (FR-03)", async () => {
    expect((await get("/places?category=halte,masjid")).body.total).toBe(4);
    expect(names((await get("/places?district=tanah-sareal")).body)).toEqual(["Halte contoh B", "Kampus contoh A"]);
    expect(names((await get("/places?status=sebagian")).body)).toEqual(["Halte contoh", "Kampus contoh B"]);
  });

  it("requires every chosen facility to be Tersedia", async () => {
    expect((await get("/places?facility=lift")).body.total).toBe(4);
    expect(names((await get("/places?facility=lift,toilet_difabel")).body)).toEqual(["Kampus contoh A", "Rumah sakit contoh"]);
  });

  it("pages with limit and offset and still reports the full total", async () => {
    const { body } = await get("/places?limit=2&offset=2");
    expect(body).toMatchObject({ total: 7, limit: 2, offset: 2 });
    expect(names(body)).toEqual(["Kampus contoh A", "Kampus contoh B"]);
  });

  it("rejects unknown filter values", async () => {
    const { status, body } = await get("/places?category=toko");
    expect(status).toBe(400);
    expect(body.galat).toBe("input_tidak_valid");
  });
});

describe("GET /places/map", () => {
  it("returns GeoJSON points for every place", async () => {
    const { status, body } = await get("/places/map");
    expect(status).toBe(200);
    expect(body.type).toBe("FeatureCollection");
    expect(body.features).toHaveLength(7);
  });

  it("limits points to the bounding box and filters", async () => {
    const { body } = await get("/places/map?bbox=106.785,-6.6,106.8,-6.59");
    expect(body.features).toEqual([
      { type: "Feature", id: halteId, geometry: { type: "Point", coordinates: [106.7942, -6.5958] }, properties: { name: "Halte contoh", category: "halte", status: "sebagian" } },
    ]);
    expect((await get("/places/map?bbox=106.785,-6.6,106.8,-6.59&status=aksesibel")).body.features).toHaveLength(0);
  });

  it("rejects a bounding box in the wrong order", async () => {
    expect((await get("/places/map?bbox=106.8,-6.6,106.785,-6.59")).status).toBe(400);
  });
});

describe("GET /places/:id", () => {
  it("returns answers, reasons, notes, the summary, and what decides the status (FR-06, FR-07)", async () => {
    const { status, body } = await get(`/places/${halteId}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      name: "Halte contoh",
      status: "sebagian",
      summary: { available: 2, relevant: 3, unknown: 0 },
      landmark: "Seberang gerbang barat Kebun Raya",
      lastVerifiedAt: "2026-10-18T03:00:00.000Z",
      needsRecheck: false,
    });
    expect(body.facilities).toEqual([
      { facility: "ramp", answer: "tersedia", reason: null, note: null },
      { facility: "toilet_difabel", answer: "tidak_perlu", reason: null, note: "Tidak ada toilet umum di halte ini" },
      { facility: "guiding_block", answer: "tidak_tersedia", reason: "tidak_sesuai", note: "Jalur terputus sebelum pintu masuk" },
      { facility: "lift", answer: "tersedia", reason: null, note: null },
    ]);
    expect(body.because).toEqual([{ facility: "guiding_block", answer: "tidak_tersedia", reason: "tidak_sesuai" }]);
  });

  it("shows only moderated photos, entrance first", async () => {
    const { body } = await get(`/places/${halteId}`);
    expect(body.photos.map((p: { tag: string }) => p.tag)).toEqual(["pintu_masuk", "lainnya"]);
  });

  it("flags places last verified more than 12 months ago (FR-38)", async () => {
    const { body } = await get(`/places/${halteBId}`);
    expect(body).toMatchObject({ status: "belum_diketahui", needsRecheck: true });
  });

  it("answers 404 for an unknown place and 400 for a malformed id", async () => {
    const missing = await get("/places/00000000-0000-4000-8000-000000000000");
    expect(missing).toEqual({ status: 404, body: { galat: "lokasi_tidak_ditemukan", pesan: "Lokasi tidak ditemukan." } });
    expect((await get("/places/bukan-id")).status).toBe(400);
  });
});

describe("GET /places/stats", () => {
  it("counts places per category, step-free entrances, and contributors (FR-01)", async () => {
    const { status, body } = await get("/places/stats");
    expect(status).toBe(200);
    expect(body).toEqual({ places: 7, byCategory: { kampus: 2, masjid: 2, halte: 2, rumah_sakit: 1 }, stepFreeEntrance: 5, contributors: 1 });
  });
});
