import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import type { Db } from "../src/db/client.js";
import { seedSampleData } from "../src/db/seed.js";
import { createTestDb } from "./helpers/db.js";

const base = { NODE_ENV: "test", DATABASE_URL: "postgresql://test@localhost/test" };
const configured = { ...base, MAPBOX_SECRET_TOKEN: "sk.rahasia", MAPBOX_USERNAME: "aksesbogor" };
const now = () => new Date("2026-11-07T10:00:00.000Z");

const feature = (name: string, lng: number, lat: number, extra: Record<string, string> = {}) => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lng, lat] },
  properties: { name, feature_type: "poi", ...extra },
});
const mapboxAnswer = () =>
  Response.json({
    type: "FeatureCollection",
    features: [
      feature("Masjid Raya Bogor", 106.8104, -6.5871, { full_address: "Jl. Raya Pajajaran, Bogor Timur, Kota Bogor" }),
      feature("Jalan tanpa titik", Number.NaN, Number.NaN),
      { type: "Feature", properties: { name: "Tanpa geometri" } },
    ],
  });

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedSampleData(db);
}, 60_000);

afterAll(async () => {
  await close();
});

async function start(env: Record<string, string>, fetch?: typeof globalThis.fetch) {
  const app = await buildApp(loadEnv(env), { db, now, fetch });
  await app.ready();
  return app;
}

const search = (app: Awaited<ReturnType<typeof start>>, payload: object, ip = "203.0.113.1") =>
  app.inject({ method: "POST", url: "/map/search", payload, remoteAddress: ip });

describe("POST /map/search", () => {
  it("answers 503 while Mapbox is not configured", async () => {
    const app = await start(base);
    const res = await search(app, { q: "masjid" });
    expect(res.statusCode).toBe(503);
    expect(res.json().galat).toBe("pencarian_belum_diatur");
    await app.close();
  });

  it("asks Mapbox Search Box around Kota Bogor and lists AksesBogor places first", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => mapboxAnswer());
    const app = await start(configured, fetch);
    const res = await search(app, { q: "masjid contoh", near: { lat: -6.6, lng: 106.8 } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body.places.map((p: { name: string }) => p.name)).toEqual(["Masjid contoh A", "Masjid contoh B"]);
    expect(body.places[0]).toMatchObject({ category: "masjid", district: { slug: "bogor-timur" }, location: { lat: -6.605, lng: 106.813 } });
    expect(body.results).toEqual([
      { name: "Masjid Raya Bogor", address: "Jl. Raya Pajajaran, Bogor Timur, Kota Bogor", location: { lat: -6.5871, lng: 106.8104 }, kind: "poi" },
    ]);
    const url = new URL(String(fetch.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe("https://api.mapbox.com/search/searchbox/v1/forward");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      q: "masjid contoh",
      access_token: "sk.rahasia",
      bbox: "106.72,-6.69,106.86,-6.5",
      proximity: "106.8,-6.6",
      country: "id",
      language: "id",
      limit: "5",
    });
    expect(res.body).not.toContain("sk.rahasia");
    await app.close();
  });

  it("answers 502 without the token when Mapbox fails", async () => {
    const app = await start(configured, vi.fn<typeof globalThis.fetch>(async () => Response.json({ message: "Not Authorized" }, { status: 401 })));
    const res = await search(app, { q: "halte" });
    expect(res.statusCode).toBe(502);
    expect(res.json().galat).toBe("pencarian_gagal");
    await app.close();
  });

  it("rejects queries that are too short, too long, or not text", async () => {
    const app = await start(configured, vi.fn<typeof globalThis.fetch>(async () => mapboxAnswer()));
    for (const payload of [{ q: "a" }, { q: "x".repeat(101) }, { q: 5 }, { q: "halte", near: { lat: 100, lng: 0 } }]) {
      expect((await search(app, payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    await app.close();
  });

  it("allows 30 searches per minute per client", async () => {
    const app = await start(configured, vi.fn<typeof globalThis.fetch>(async () => mapboxAnswer()));
    for (let i = 0; i < 30; i++) expect((await search(app, { q: "halte" }, "203.0.113.9")).statusCode).toBe(200);
    const res = await search(app, { q: "halte" }, "203.0.113.9");
    expect(res.statusCode).toBe(429);
    expect(res.json().galat).toBe("terlalu_sering");
    expect((await search(app, { q: "halte" }, "203.0.113.10")).statusCode).toBe(200);
    await app.close();
  });
});
