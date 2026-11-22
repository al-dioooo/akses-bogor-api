import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/client.js";
import { seedSampleData } from "../src/db/seed.js";
import { parseOverpass, type OverpassElement } from "../src/knowledge/osm.js";
import { loadOsm } from "../src/knowledge/osm-store.js";
import { DirectionsQuotaError, NoRouteError, type WalkingRouter } from "../src/map/directions.js";
import { decodePolyline, encodePolyline } from "../src/map/polyline.js";
import { ROUTE_WARNING, describeFeature, routeObstacles, walkingRoute, type RouteContext } from "../src/map/walking-route.js";
import { loadFacilities, parseFacilities } from "../src/contribute/facilities.js";
import { placesNamed } from "../src/places/queries.js";
import { createTestDb } from "./helpers/db.js";

let db: Db;
let close: () => Promise<void>;
let halteId: string;
const now = () => new Date("2026-11-16T05:00:00.000Z");

// Rute contoh di Bogor Tengah, berakhir di pin "Halte contoh" (106.7942, -6.5958).
const line: [number, number][] = [
  [106.7972, -6.5965],
  [106.7955, -6.596],
  [106.7942, -6.5958],
];
const osm: OverpassElement[] = [
  // Tangga 5 m dari garis rute, di dekat ujung rute.
  { type: "way", id: 1, geometry: [{ lat: -6.59585, lon: 106.79435 }, { lat: -6.5959, lon: 106.7945 }], tags: { highway: "steps", step_count: "4", "ramp:wheelchair": "no" } },
  // Kerb tinggi tepat di awal rute.
  { type: "node", id: 2, lat: -6.5965, lon: 106.7971, tags: { kerb: "raised" } },
  // Pintu masuk 300 m dari rute: di luar jarak 20 m.
  { type: "node", id: 3, lat: -6.5935, lon: 106.7955, tags: { entrance: "main", wheelchair: "yes" } },
  // Halte bukan hambatan dan tidak ikut.
  { type: "node", id: 4, lat: -6.596, lon: 106.7955, tags: { highway: "bus_stop", name: "Halte X" } },
];

const fakeRouter = (): WalkingRouter =>
  vi.fn(async () => ({
    distanceMeters: 352,
    durationSeconds: 254,
    steps: [{ instruction: "Berjalan ke barat", distanceMeters: 352, durationSeconds: 254, name: "Jalan Contoh", maneuver: "depart", location: { lat: -6.5965, lng: 106.7972 } }],
    geometry: { type: "LineString" as const, coordinates: line },
  }));

const context = (walking?: WalkingRouter): RouteContext => ({ db, now, walking });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedSampleData(db);
  await loadOsm(db, parseOverpass({ elements: osm }), { url: "https://overpass-api.de/api/interpreter", retrievedAt: now(), sha256: "b".repeat(64) });
  halteId = (await placesNamed(db, "Halte contoh", 5)).find((p) => p.name === "Halte contoh")!.id;
}, 60_000);

afterAll(async () => {
  await close();
});

describe("polyline", () => {
  it("encodes and decodes coordinates with six decimals", () => {
    expect(decodePolyline(encodePolyline(line))).toEqual(line);
  });

  it("rejects a broken string", () => {
    expect(() => decodePolyline("_p~iF~ps|U_")).toThrow();
    expect(() => decodePolyline("ab cd")).toThrow();
  });
});

describe("walkingRoute", () => {
  it("asks for a route from a rounded position to the place pin and adds the warning", async () => {
    const walking = fakeRouter();
    const route = await walkingRoute(context(walking), { from: { lat: -6.596512345, lng: 106.797187654 }, placeId: halteId });
    expect(walking).toHaveBeenCalledWith({ lat: -6.5965, lng: 106.7972 }, { lat: -6.5958, lng: 106.7942 });
    expect(route).toMatchObject({
      destination: { placeId: halteId, osm: null, name: "Halte contoh", location: { lat: -6.5958, lng: 106.7942 } },
      distanceMeters: 352,
      durationSeconds: 254,
      warning: ROUTE_WARNING,
      attribution: "© Mapbox © OpenStreetMap",
    });
    expect(decodePolyline(route.polyline)).toEqual(line);
  });

  it("routes to an OpenStreetMap place without AksesBogor data for contributors", async () => {
    await loadFacilities(db, parseFacilities({ elements: [{ type: "node", id: 88, lat: -6.5961, lon: 106.7951, tags: { highway: "bus_stop" } }] }), {
      url: "https://overpass-api.de/api/interpreter",
      retrievedAt: now(),
      sha256: "b".repeat(64),
    });
    const walking = fakeRouter();
    const route = await walkingRoute(context(walking), { from: { lat: -6.5965, lng: 106.7972 }, osm: { type: "node", id: 88 } });
    expect(walking).toHaveBeenCalledWith({ lat: -6.5965, lng: 106.7972 }, { lat: -6.5961, lng: 106.7951 });
    expect(route.destination).toEqual({ placeId: null, osm: { type: "node", id: 88 }, name: null, location: { lat: -6.5961, lng: 106.7951 } });
    await expect(walkingRoute(context(walking), { from: { lat: -6.5965, lng: 106.7972 }, osm: { type: "node", id: 89 } })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses positions outside Kota Bogor or too far away, before calling Mapbox", async () => {
    const walking = fakeRouter();
    await expect(walkingRoute(context(walking), { from: { lat: -6.2, lng: 106.82 }, placeId: halteId })).rejects.toMatchObject({ statusCode: 422, code: "di_luar_kota_bogor" });
    expect(walking).not.toHaveBeenCalled();
  });

  it("maps Mapbox failures to clear errors", async () => {
    const failing = (error: Error): WalkingRouter => vi.fn(async () => Promise.reject(error));
    const from = { lat: -6.5965, lng: 106.7972 };
    await expect(walkingRoute(context(), { from, placeId: halteId })).rejects.toMatchObject({ statusCode: 503, code: "rute_belum_diatur" });
    await expect(walkingRoute(context(failing(new NoRouteError("x"))), { from, placeId: halteId })).rejects.toMatchObject({ statusCode: 422, code: "rute_tidak_ditemukan" });
    await expect(walkingRoute(context(failing(new DirectionsQuotaError("x"))), { from, placeId: halteId })).rejects.toMatchObject({ statusCode: 503, code: "rute_penuh" });
    await expect(walkingRoute(context(failing(new Error("Mapbox Directions menjawab 500"))), { from, placeId: halteId })).rejects.toMatchObject({ statusCode: 502, code: "rute_gagal" });
    await expect(walkingRoute(context(fakeRouter()), { from, placeId: "00000000-0000-4000-8000-000000000000" })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("routeObstacles", () => {
  it("lists OSM obstacles near the route in route order, with a description and a link", async () => {
    const result = await routeObstacles(context(), { polyline: encodePolyline(line) });
    expect(result.bufferMeters).toBe(20);
    expect(result.truncated).toBe(false);
    expect(result.features.map((f) => [f.kind, f.description, f.osm.url])).toEqual([
      ["kerb", "Kerb tinggi", "https://www.openstreetmap.org/node/2"],
      ["tangga", "Tangga, 4 anak tangga, tanpa ramp", "https://www.openstreetmap.org/way/1"],
    ]);
    expect(result.features[0]!.alongRouteMeters).toBeLessThan(result.features[1]!.alongRouteMeters);
    expect(result.features[1]!.distanceFromRouteMeters).toBeLessThanOrEqual(20);
    expect(result.attribution).toContain("OpenStreetMap");
  });

  it("stays within the buffer and never lists bus stops", async () => {
    const result = await routeObstacles(context(), { polyline: encodePolyline(line), bufferMeters: 50 });
    expect(result.features.map((f) => f.osm.id)).toEqual([2, 1]);
    expect(result.features.every((f) => f.distanceFromRouteMeters <= 50)).toBe(true);
  });

  it("rejects a broken polyline or a line outside Kota Bogor", async () => {
    await expect(routeObstacles(context(), { polyline: "!!" })).rejects.toMatchObject({ statusCode: 400, code: "garis_rute_tidak_valid" });
    const jakarta = encodePolyline([
      [106.82, -6.2],
      [106.83, -6.21],
    ]);
    await expect(routeObstacles(context(), { polyline: jakarta })).rejects.toMatchObject({ statusCode: 422, code: "garis_rute_tidak_valid" });
  });
});

describe("describeFeature", () => {
  it("describes kerbs, entrances and guiding blocks in Indonesian", () => {
    expect(describeFeature("kerb", { kerb: "lowered", tactile_paving: "yes" })).toBe("Kerb diturunkan, ada guiding block");
    expect(describeFeature("pintu_masuk", { entrance: "main", wheelchair: "limited", automatic_door: "yes", width: "0.9" })).toBe(
      "Pintu masuk utama, pintu otomatis, lebar 0.9, terbatas untuk kursi roda",
    );
    expect(describeFeature("guiding_block", { tactile_paving: "no" })).toBe("Tanpa guiding block di titik ini");
  });
});
