import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { loadFacilities, parseFacilities } from "../src/contribute/facilities.js";
import type { Db } from "../src/db/client.js";
import { places } from "../src/db/schema.js";
import { seedSampleData } from "../src/db/seed.js";
import { createTestDb } from "./helpers/db.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const BASE_ENV = { NODE_ENV: "test", DATABASE_URL: "postgresql://test@localhost/test", MAPBOX_SECRET_TOKEN: "sk.rahasia", MAPBOX_USERNAME: "aksesbogor" };

let db: Db;
let close: () => Promise<void>;
let hospitalId: string;
const calls: URL[] = [];

/** Mapbox dan Google palsu: "Rumah sakit contoh" di seed (106.764, -6.57) punya padanan di keduanya. */
const fetch = (async (input: string | URL) => {
  const url = new URL(String(input));
  calls.push(url);
  if (url.pathname.endsWith("/forward")) {
    return json({ features: [{ geometry: { coordinates: [106.7641, -6.5701] }, properties: { name: "RS Contoh Bogor", mapbox_id: "rs-contoh", poi_category_ids: ["hospital"] } }] });
  }
  if (url.pathname.includes("/retrieve/")) return json({ features: [{ properties: { metadata: { wheelchair_accessible: false } } }] });
  if (url.pathname.endsWith(":searchText")) {
    return json({
      places: [
        {
          id: "ChIJcontoh",
          displayName: { text: "Rumah Sakit Contoh" },
          location: { latitude: -6.5702, longitude: 106.764 },
          types: ["hospital", "point_of_interest"],
          googleMapsUri: "https://maps.google.com/?cid=2",
          accessibilityOptions: { wheelchairAccessibleEntrance: true, wheelchairAccessibleRestroom: true },
        },
      ],
    });
  }
  return json({ error: "tidak dikenal" }, 404);
}) as typeof globalThis.fetch;

async function appWith(env: Record<string, string>) {
  const app = await buildApp(loadEnv({ ...BASE_ENV, ...env }), { db, fetch, now: () => new Date("2026-11-23T03:00:00Z") });
  await app.ready();
  return app;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedSampleData(db);
  hospitalId = (await db.select({ id: places.id }).from(places).where(eq(places.name, "Rumah sakit contoh")))[0]!.id;
  const rows = parseFacilities({
    elements: [
      { type: "way", id: 2, center: { lat: -6.5705, lon: 106.7645 }, tags: { amenity: "place_of_worship", religion: "muslim", name: "Masjid Al-Ikhlas" } },
      { type: "node", id: 7, lat: -6.5801, lon: 106.79, tags: { highway: "bus_stop" } },
    ],
  });
  await loadFacilities(db, rows, { url: "https://overpass-api.de/api/interpreter", retrievedAt: new Date("2026-11-22T10:00:00.000Z"), sha256: "e".repeat(64) });
  // Salinan tersimpan, seperti 38 baris kandidat di produksi.
  const google = { sumber: "Google Maps", nama: "Masjid Al-Ikhlas", url: "https://maps.google.com/?cid=9", place_id: "ChIJikhlas", aksesibilitas: ["wheelchairAccessibleEntrance"], diambil: "2026-11-23", metode: "places-api", jarak_titik_m: 9 };
  await db.execute(sql`
    UPDATE osm_places SET tags = tags || jsonb_build_object('aksesbogor:google_maps', ${JSON.stringify(google)}::jsonb, 'aksesbogor:osm_aksesibilitas', '{"wheelchair":"limited","arti":"sebagian"}'::jsonb)
    WHERE osm_type = 'way' AND osm_id = 2`);
}, 60_000);

afterAll(async () => {
  await close();
});

describe("GET /places/:id/hints", () => {
  it("returns one labelled line per provider, never cached by the browser", async () => {
    const app = await appWith({ PROVIDER_HINTS_ENABLED: "true", GOOGLE_MAPS_API_KEY: "kunci-google" });
    try {
      const res = await app.inject({ method: "GET", url: `/places/${hospitalId}/hints` });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(res.json()).toEqual({
        hints: [
          { provider: "mapbox", result: "found", placeName: "RS Contoh Bogor", distanceMeters: 16, wheelchairAccessible: false },
          {
            provider: "google",
            result: "found",
            placeName: "Rumah Sakit Contoh",
            distanceMeters: 22,
            url: "https://maps.google.com/?cid=2",
            accessibility: { entrance: true, restroom: true, parking: null, seating: null },
          },
        ],
      });
      expect((await app.inject({ method: "GET", url: "/places/00000000-0000-4000-8000-000000000000/hints" })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("returns no hints and calls no provider while the switch is off, and leaves Google out without its key", async () => {
    calls.length = 0;
    const off = await appWith({ GOOGLE_MAPS_API_KEY: "kunci-google" });
    try {
      expect((await off.inject({ method: "GET", url: `/places/${hospitalId}/hints` })).json()).toEqual({ hints: [] });
      // Returns early without looking the place up.
      expect((await off.inject({ method: "GET", url: "/places/00000000-0000-4000-8000-000000000000/hints" })).json()).toEqual({ hints: [] });
      expect(calls).toEqual([]);
    } finally {
      await off.close();
    }
    const mapboxOnly = await appWith({ PROVIDER_HINTS_ENABLED: "true" });
    try {
      const { hints } = (await mapboxOnly.inject({ method: "GET", url: `/places/${hospitalId}/hints` })).json();
      expect(hints.map((h: { provider: string }) => h.provider)).toEqual(["mapbox"]);
    } finally {
      await mapboxOnly.close();
    }
  });
});

describe("GET /places/candidates/:osmType/:osmId/hints", () => {
  it("looks up named candidates, skips unnamed ones without calling a provider, and rejects unknown ids", async () => {
    const app = await appWith({ PROVIDER_HINTS_ENABLED: "true" });
    try {
      // The fake Mapbox POI is a hospital, so the masjid has no match.
      const named = await app.inject({ method: "GET", url: "/places/candidates/way/2/hints" });
      expect(named.statusCode).toBe(200);
      expect(named.json().hints[0]).toEqual({ provider: "mapbox", result: "none" });
      calls.length = 0;
      expect((await app.inject({ method: "GET", url: "/places/candidates/node/7/hints" })).json()).toEqual({ hints: [{ provider: "mapbox", result: "none" }] });
      expect(calls).toEqual([]);
      expect((await app.inject({ method: "GET", url: "/places/candidates/node/999/hints" })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/places/candidates/area/2/hints" })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("adds the stored Google Maps copy and OSM note, but not while the switch is off", async () => {
    const app = await appWith({ PROVIDER_HINTS_ENABLED: "true" });
    try {
      const res = await app.inject({ method: "GET", url: "/places/candidates/way/2/hints" });
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(res.json()).toEqual({
        hints: [
          { provider: "mapbox", result: "none" },
          {
            provider: "google",
            result: "stored",
            placeName: "Masjid Al-Ikhlas",
            distanceMeters: 9,
            url: "https://maps.google.com/?cid=9",
            retrievedAt: "2026-11-23",
            accessibility: { entrance: true, restroom: null, parking: null, seating: null },
          },
          { provider: "openstreetmap", result: "stored", wheelchair: "limited" },
        ],
      });
    } finally {
      await app.close();
    }
    const off = await appWith({});
    try {
      expect((await off.inject({ method: "GET", url: "/places/candidates/way/2/hints" })).json()).toEqual({ hints: [] });
    } finally {
      await off.close();
    }
  });
});
