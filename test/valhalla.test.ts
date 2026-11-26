import { describe, expect, it, vi } from "vitest";
import { encodePolyline } from "../src/map/polyline.js";
import { NoNearbyPathError, NoPathError, valhallaRouter } from "../src/map/valhalla.js";
import { cardinal, stepFrom } from "../src/map/valhalla-steps.js";

const line: [number, number][] = [
  [106.7906, -6.5954],
  [106.7915, -6.5955],
  [106.7963, -6.5946],
];
const from = { lat: -6.5954, lng: 106.7906 };
const to = { lat: -6.5946, lng: 106.7963 };

const routeAnswer = {
  trip: {
    summary: { length: 0.652, time: 512.4 },
    legs: [
      {
        shape: encodePolyline(line),
        maneuvers: [
          { type: 1, length: 0.1, time: 80, bearing_after: 92, begin_shape_index: 0 },
          { type: 10, street_names: ["2", "11", "Jalan Kapten Muslihat"], length: 0.552, time: 432, begin_shape_index: 1 },
          { type: 4, length: 0, time: 0, begin_shape_index: 2 },
        ],
      },
    ],
  },
};
const attributes = { edges: [{ way_id: 11, length: 0.1, use: "footway" }, { way_id: 12, length: 0.552, use: "road" }] };

type Call = { url: string; body: Record<string, unknown> };
function fakeValhalla(answers: { route?: unknown; routeStatus?: number; attributes?: unknown; attributesStatus?: number } = {}) {
  const calls: Call[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    if (url.endsWith("/route")) return Response.json(answers.route ?? routeAnswer, { status: answers.routeStatus ?? 200 });
    return Response.json(answers.attributes ?? attributes, { status: answers.attributesStatus ?? 200 });
  });
  return { calls, router: valhallaRouter({ url: "http://127.0.0.1:8002/", fetch }) };
}

describe("valhallaRouter", () => {
  it("asks for a wheelchair route, then for the OSM ways along the same line", async () => {
    const { calls, router } = fakeValhalla();
    const route = await router(from, to, "kursi_roda");
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:8002/route", "http://127.0.0.1:8002/trace_attributes"]);
    expect(calls[0]!.body).toMatchObject({
      locations: [
        { lat: -6.5954, lon: 106.7906 },
        { lat: -6.5946, lon: 106.7963 },
      ],
      costing: "pedestrian",
      costing_options: { pedestrian: { type: "wheelchair", use_tracks: 0 } },
    });
    expect(calls[1]!.body).toMatchObject({ encoded_polyline: encodePolyline(line), shape_match: "walk_or_snap", costing_options: { pedestrian: { type: "wheelchair" } } });
    expect(route).toMatchObject({ distanceMeters: 652, durationSeconds: 512, coordinates: line });
    expect(route.maneuvers[1]).toEqual({ type: 10, streetNames: ["2", "11", "Jalan Kapten Muslihat"], distanceMeters: 552, durationSeconds: 432, bearing: null, location: { lat: -6.5955, lng: 106.7915 } });
    expect(route.edges).toEqual([
      { wayId: 11, lengthMeters: 100, use: "footway" },
      { wayId: 12, lengthMeters: 552, use: "road" },
    ]);
  });

  it("uses the plain pedestrian type for walking", async () => {
    const { calls, router } = fakeValhalla();
    await router(from, to, "jalan_kaki");
    expect(calls[0]!.body).toMatchObject({ costing_options: { pedestrian: { type: "foot" } } });
  });

  it("tells a missing path apart from a point far from any path", async () => {
    await expect(fakeValhalla({ route: { error_code: 442, error: "No path could be found for input" }, routeStatus: 400 }).router(from, to, "kursi_roda")).rejects.toBeInstanceOf(NoPathError);
    await expect(fakeValhalla({ route: { error_code: 171 }, routeStatus: 400 }).router(from, to, "kursi_roda")).rejects.toBeInstanceOf(NoNearbyPathError);
    await expect(fakeValhalla({ route: { error_code: 154 }, routeStatus: 400 }).router(from, to, "kursi_roda")).rejects.toThrow("Valhalla menjawab 400 154");
  });

  it("keeps the route when the ways along it cannot be matched", async () => {
    const route = await fakeValhalla({ attributes: { error_code: 443 }, attributesStatus: 400 }).router(from, to, "jalan_kaki");
    expect(route.edges).toBeNull();
    expect(route.distanceMeters).toBe(652);
  });

  it("reports an unreachable server without the request body", async () => {
    const router = valhallaRouter({ url: "http://127.0.0.1:8002", fetch: vi.fn(async () => Promise.reject(new TypeError("fetch failed"))) });
    await expect(router(from, to, "kursi_roda")).rejects.toThrow("Valhalla tidak bisa dihubungi");
  });
});

describe("stepFrom", () => {
  const base = { distanceMeters: 40, durationSeconds: 30, location: { lat: -6.6, lng: 106.8 } };

  it("writes the steps in Indonesian", () => {
    expect(stepFrom({ ...base, type: 1, streetNames: [], bearing: 92 })).toMatchObject({ instruction: "Mulai berjalan ke arah timur", maneuver: "depart", name: null });
    expect(stepFrom({ ...base, type: 10, streetNames: ["2", "11", "Jalan Kapten Muslihat"], bearing: 180 })).toMatchObject({
      instruction: "Belok kanan ke Jalan Kapten Muslihat",
      maneuver: "turn",
      name: "Jalan Kapten Muslihat",
    });
    expect(stepFrom({ ...base, type: 15, streetNames: [], bearing: null }).instruction).toBe("Belok kiri");
    expect(stepFrom({ ...base, type: 8, streetNames: ["Jalan Pajajaran"], bearing: null }).instruction).toBe("Jalan terus di Jalan Pajajaran");
    expect(stepFrom({ ...base, type: 40, streetNames: [], bearing: null })).toMatchObject({ instruction: "Lewati tangga", maneuver: "steps" });
    expect(stepFrom({ ...base, type: 6, streetNames: [], bearing: null })).toMatchObject({ instruction: "Tiba di tujuan, di sebelah kiri", maneuver: "arrive" });
    expect(stepFrom({ ...base, type: 99, streetNames: ["Gang Mawar"], bearing: null })).toMatchObject({ instruction: "Lanjut ke Gang Mawar", maneuver: "other" });
  });

  it("names the compass direction", () => {
    expect([0, 44, 90, 135, 181, 225, 270, 316, 359].map(cardinal)).toEqual(["utara", "timur laut", "timur", "tenggara", "selatan", "barat daya", "barat", "barat laut", "utara"]);
  });
});
