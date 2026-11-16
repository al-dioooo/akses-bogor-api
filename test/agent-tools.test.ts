import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { decodePolyline, encodePolyline } from "../src/agent/polyline.js";
import { ROUTE_WARNING, describeFeature, findPlace, placeAccessibility, routeObstacles, searchKnowledgeTool, walkingRoute, type ToolContext } from "../src/agent/tools.js";
import type { Db } from "../src/db/client.js";
import { seedSampleData } from "../src/db/seed.js";
import { parseOverpass, type OverpassElement } from "../src/knowledge/osm.js";
import { loadOsm } from "../src/knowledge/osm-store.js";
import { insertPassages, replaceSource } from "../src/knowledge/store.js";
import { DirectionsQuotaError, NoRouteError, type WalkingRouter } from "../src/map/directions.js";
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

const context = (walking?: WalkingRouter): ToolContext => ({ db, now, walking });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedSampleData(db);
  await loadOsm(db, parseOverpass({ elements: osm }), { url: "https://overpass-api.de/api/interpreter", retrievedAt: now(), sha256: "b".repeat(64) });
  const source = { id: "uu-8-2016", kind: "regulasi" as const, title: "UU No. 8 Tahun 2016", url: "https://peraturan.go.id/files/uu8-2016bt.pdf", license: "Tanpa hak cipta", retrievedAt: now() };
  await replaceSource(db, source, (tx) => insertPassages(tx, source.id, [{ citation: "UU No. 8 Tahun 2016, Pasal 18", body: "Hak Aksesibilitas untuk fasilitas publik." }]));
  halteId = (await findPlace(context(), { query: "Halte contoh" })).places.find((p) => p.name === "Halte contoh")!.id;
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

describe("find_place", () => {
  it("finds published places by part of the name", async () => {
    const { places } = await findPlace(context(), { query: "halte" });
    expect(places.map((p) => p.name).sort()).toEqual(["Halte contoh", "Halte contoh B"]);
    expect(places[0]).toMatchObject({ category: "halte", district: { slug: expect.any(String) }, location: { lat: expect.any(Number) } });
  });
});

describe("place_accessibility", () => {
  it("returns the verified answers, status and last verification date", async () => {
    const place = await placeAccessibility(context(), { placeId: halteId });
    expect(place).toMatchObject({
      name: "Halte contoh",
      status: "sebagian",
      summary: { available: 2, relevant: 3, unknown: 0 },
      lastVerifiedAt: "2026-10-18T03:00:00.000Z",
      needsRecheck: false,
      because: [{ facility: "guiding_block", answer: "tidak_tersedia", reason: "tidak_sesuai" }],
    });
    expect(place.facilities).toContainEqual({ facility: "guiding_block", answer: "tidak_tersedia", reason: "tidak_sesuai", note: "Jalur terputus sebelum pintu masuk" });
    expect(place).not.toHaveProperty("photos");
  });

  it("answers 404 for an unknown place", async () => {
    await expect(placeAccessibility(context(), { placeId: "00000000-0000-4000-8000-000000000000" })).rejects.toMatchObject({ statusCode: 404, code: "lokasi_tidak_ditemukan" });
  });
});

describe("walking_route", () => {
  it("asks for a route from a rounded position to the place pin and adds the warning", async () => {
    const walking = fakeRouter();
    const route = await walkingRoute(context(walking), { from: { lat: -6.596512345, lng: 106.797187654 }, placeId: halteId });
    expect(walking).toHaveBeenCalledWith({ lat: -6.5965, lng: 106.7972 }, { lat: -6.5958, lng: 106.7942 });
    expect(route).toMatchObject({
      destination: { placeId: halteId, name: "Halte contoh", location: { lat: -6.5958, lng: 106.7942 } },
      distanceMeters: 352,
      durationSeconds: 254,
      warning: ROUTE_WARNING,
      attribution: "© Mapbox © OpenStreetMap",
    });
    expect(decodePolyline(route.polyline)).toEqual(line);
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

describe("route_obstacles", () => {
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

describe("search_knowledge", () => {
  it("returns passages with their citation and licence", async () => {
    const { passages } = await searchKnowledgeTool(context(), { query: "hak aksesibilitas" });
    expect(passages[0]).toMatchObject({ citation: "UU No. 8 Tahun 2016, Pasal 18", source: { license: "Tanpa hak cipta" } });
  });
});
