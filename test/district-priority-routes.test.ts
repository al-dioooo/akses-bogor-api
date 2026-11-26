import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { DISABILITY_CAVEAT, loadDisabilityCounts, parseDisabilityCounts } from "../src/contribute/disability.js";
import { loadFacilities, parseFacilities } from "../src/contribute/facilities.js";
import type { Db } from "../src/db/client.js";
import { seedSampleData } from "../src/db/seed.js";
import { createTestDb } from "./helpers/db.js";

describe("district routes", () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let closed: Awaited<ReturnType<typeof buildApp>>;
  const base = { NODE_ENV: "test", DATABASE_URL: "postgresql://test@localhost/test" };
  const raw = { url: "https://overpass-api.de/api/interpreter", retrievedAt: new Date("2026-11-22T10:00:00.000Z"), sha256: "f".repeat(64) };

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await seedSampleData(db);
    const slugs = ["bogor-barat", "bogor-selatan", "bogor-tengah", "bogor-timur", "bogor-utara", "tanah-sareal"];
    const rows = [
      ...slugs.map((slug, i) => ({ bps_nama_kecamatan: slug.replace("-", " ").toUpperCase(), jenis_disabilitas: "CACAT TUBUH", jumlah: (i + 1) * 10, tahun: 2024 })),
      { bps_nama_kecamatan: "BOGOR BARAT", jenis_disabilitas: "CACAT NETRA", jumlah: 5, tahun: 2023 },
    ];
    await loadDisabilityCounts(db, parseDisabilityCounts({ data: rows }, slugs), raw);
    await loadFacilities(db, parseFacilities({ elements: [{ type: "node", id: 9, lat: -6.5705, lon: 106.7645, tags: { amenity: "hospital", name: "RS Baru" } }] }), raw);
    app = await buildApp(loadEnv({ ...base, DISABILITY_DATA_ENABLED: "true" }), { db });
    closed = await buildApp(loadEnv(base), { db });
    await Promise.all([app.ready(), closed.ready()]);
  }, 60_000);

  afterAll(async () => {
    await Promise.all([app.close(), closed.close()]);
    await close();
  });

  it("keeps the priority closed while DISABILITY_DATA_ENABLED is off", async () => {
    const res = await closed.inject({ method: "GET", url: "/districts/priority" });
    expect(res.statusCode).toBe(503);
    expect(res.json().galat).toBe("data_disabilitas_belum_aktif");
  });

  it("ranks the kecamatan from the latest year with the caveat, formula and source", async () => {
    const res = await app.inject({ method: "GET", url: "/districts/priority" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ year: 2024, yearTotals: [{ year: 2023, registered: 5 }, { year: 2024, registered: 210 }], caveat: DISABILITY_CAVEAT });
    expect(body.source).toMatchObject({ publisher: expect.stringContaining("Dinas Sosial"), retrievedAt: "2026-11-22T10:00:00.000Z", terms: expect.stringContaining("pihak ketiga") });
    const barat = body.districts.find((d: { slug: string }) => d.slug === "bogor-barat");
    // Bogor Barat: 10 terdaftar pada 2024, satu lokasi AksesBogor contoh, satu rumah sakit OSM tanpa data.
    expect(barat).toMatchObject({ registered: 10, verifiedPlaces: 1, facilitiesWithoutData: 1 });
    expect(body.districts.map((d: { rank: number }) => d.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(JSON.stringify(body)).not.toMatch(/cacat/i);
  });

  it("serves simplified kecamatan boundaries with OSM attribution, whatever the flag", async () => {
    const res = await closed.inject({ method: "GET", url: "/districts/boundaries" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=86400");
    const body = res.json();
    expect(body.attribution).toContain("OpenStreetMap");
    expect(body.features.map((f: { properties: { slug: string } }) => f.properties.slug)).toHaveLength(6);
    expect(body.features[0].geometry.type).toMatch(/Polygon/);
    expect(JSON.stringify(body.features[0].geometry.coordinates)).not.toMatch(/\d\.\d{6,}/);
  });

  it("adds the Kota Bogor outline: one outer ring per part, no holes between kecamatan, 5 decimals", async () => {
    const body = (await closed.inject({ method: "GET", url: "/districts/boundaries" })).json();
    expect(body.outline.type).toBe("MultiPolygon");
    const polygons = body.outline.coordinates as [number, number][][][];
    // Kota Bogor satu wilayah yang menyambung; potongan kecil di antara batas tidak ikut.
    expect(polygons).toHaveLength(1);
    expect(polygons.every((rings) => rings.length === 1)).toBe(true);
    expect(JSON.stringify(polygons)).not.toMatch(/\d\.\d{6,}/);
    // Garis luar mencakup semua kecamatan: kotak batasnya sama dengan gabungan kotak batas kecamatan.
    const points = (value: unknown): number[][] => (Array.isArray(value) && typeof value[0] === "number" ? [value as number[]] : (value as unknown[]).flatMap(points));
    const bounds = (all: number[][]) => [0, 1].flatMap((axis) => [Math.min(...all.map((p) => p[axis]!)), Math.max(...all.map((p) => p[axis]!))]);
    const districts = bounds((body.features as { geometry: { coordinates: unknown } }[]).flatMap((f) => points(f.geometry.coordinates)));
    bounds(points(polygons)).forEach((value, i) => expect(value).toBeCloseTo(districts[i]!, 3));
  });
});
