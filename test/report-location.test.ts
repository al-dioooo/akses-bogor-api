import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { places } from "../src/db/schema.js";
import { seedSampleData } from "../src/db/seed.js";
import { createTestDb } from "./helpers/db.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let close: () => Promise<void>;
let halteId: string;

// Halte contoh di seed: Bogor Tengah, 106.7942, -6.5958.
const HALTE = { lat: -6.5958, lng: 106.7942 };
// Sekitar 30 m ke utara dari Halte contoh.
const NEAR_HALTE = { lat: -6.59553, lng: 106.7942 };

beforeAll(async () => {
  const test = await createTestDb();
  close = test.close;
  await seedSampleData(test.db);
  halteId = (await test.db.select({ id: places.id }).from(places).where(eq(places.name, "Halte contoh")))[0]!.id;
  app = await buildApp(loadEnv({ NODE_ENV: "test", DATABASE_URL: "postgresql://test@localhost/test" }), { db: test.db });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await close();
});

const check = (payload: object) => app.inject({ method: "POST", url: "/reports/location-check", payload });

describe("POST /reports/location-check", () => {
  it("returns the kecamatan computed from the point", async () => {
    const res = await check({ location: { lat: -6.5976, lng: 106.7991 } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({ district: { slug: "bogor-tengah", name: "Bogor Tengah" }, nearby: [] });
  });

  it("rejects a point outside Kota Bogor with the coverage message (FR-22)", async () => {
    // Kampus IPB Dramaga, Kabupaten Bogor
    const res = await check({ location: { lat: -6.5579, lng: 106.7268 } });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ galat: "di_luar_kota_bogor", pesan: expect.stringContaining("enam kecamatan Kota Bogor") });
  });

  it("lists published places with a similar name within about 50 m (FR-23)", async () => {
    const res = await check({ location: NEAR_HALTE, name: "halte  Contoh" });
    expect(res.statusCode).toBe(200);
    const [match, ...rest] = res.json().nearby;
    expect(rest).toEqual([]);
    expect(match).toEqual({ id: halteId, name: "Halte contoh", category: "halte", status: expect.any(String), distanceMeters: expect.any(Number) });
    expect(match.distanceMeters).toBeGreaterThan(20);
    expect(match.distanceMeters).toBeLessThan(40);
  });

  it("matches a name that contains the other, and ignores different names", async () => {
    expect((await check({ location: NEAR_HALTE, name: "Halte" })).json().nearby).toHaveLength(1);
    expect((await check({ location: NEAR_HALTE, name: "Masjid Agung" })).json().nearby).toEqual([]);
  });

  it("treats every place within the radius as possible without a name", async () => {
    expect((await check({ location: HALTE })).json().nearby).toHaveLength(1);
  });

  it("ignores places farther than 50 m", async () => {
    // Sekitar 110 m dari Halte contoh
    expect((await check({ location: { lat: -6.5948, lng: 106.7942 }, name: "Halte contoh" })).json().nearby).toEqual([]);
  });

  it("leaves out the place being edited", async () => {
    expect((await check({ location: HALTE, name: "Halte contoh", placeId: halteId })).json().nearby).toEqual([]);
  });

  it("rejects invalid coordinates and names", async () => {
    for (const payload of [
      { location: { lat: 91, lng: 106.79 } },
      { location: { lat: "-6.59", lng: 106.79 } },
      { location: HALTE, name: "a\u0000b" },
      { location: HALTE, name: "x".repeat(121) },
      { location: HALTE, placeId: "bukan-uuid" },
    ]) {
      const res = await check(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().galat).toBe("input_tidak_valid");
    }
  });
});
