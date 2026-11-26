import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import type { Db } from "../src/db/client.js";
import { seedSampleData } from "../src/db/seed.js";
import { ACCESSIBLE_NOTE } from "../src/map/accessible-route.js";
import { WAY } from "../src/map/accessible-ways.js";
import { encodePolyline } from "../src/map/polyline.js";
import { placesNamed } from "../src/places/queries.js";
import { ACCESSIBLE_ROUTES_PER_HOUR } from "../src/routes/agent.js";
import { createTestDb } from "./helpers/db.js";

const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test@localhost/test",
  BETTER_AUTH_SECRET: "rahasia-tes-yang-panjangnya-lebih-dari-32-karakter",
  MAPBOX_SECRET_TOKEN: "sk.rahasia",
  MAPBOX_USERNAME: "aksesbogor",
  ROUTE_ASSISTANT_ENABLED: "true",
};
const NOW = new Date("2026-11-26T05:00:00.000Z");
/** Beberapa meter dari Halte contoh di Bogor Tengah, dengan lebih dari 4 desimal. */
const nearHalte = { lat: -6.596512345, lng: 106.797187654 };
const line: [number, number][] = [
  [106.7972, -6.5965],
  [106.7942, -6.5958],
];

let valhallaPath = { status: 200, body: {} as unknown };
const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
  const url = String(input);
  if (url === "http://127.0.0.1:8002/route") return Response.json(valhallaPath.body, { status: valhallaPath.status });
  if (url === "http://127.0.0.1:8002/trace_attributes") {
    return Response.json({ edges: [{ way_id: 1, length: 0.25, use: "sidewalk" }, { way_id: 2, length: 0.1, use: "road" }] });
  }
  throw new Error(`Permintaan tak terduga ke ${url}`);
});
const found = {
  status: 200,
  body: {
    trip: {
      summary: { length: 0.35, time: 290 },
      legs: [
        {
          shape: encodePolyline(line),
          maneuvers: [
            { type: 2, length: 0.35, time: 290, bearing_after: 270, begin_shape_index: 0 },
            { type: 4, length: 0, time: 0, begin_shape_index: 1 },
          ],
        },
      ],
    },
  },
};

let db: Db;
let close: () => Promise<void>;
let dir: string;
let on: Awaited<ReturnType<typeof buildApp>>;
let noWays: Awaited<ReturnType<typeof buildApp>>;
let off: Awaited<ReturnType<typeof buildApp>>;
let halteId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedSampleData(db);
  dir = await mkdtemp(join(tmpdir(), "jalur-"));
  const waysFile = join(dir, "jalur.json");
  await writeFile(waysFile, JSON.stringify({ versi: 1, sumber: "java-latest.osm.pbf 2026-11-25", jalur: { 1: WAY.sidewalkKnown | WAY.surfaceKnown } }));
  const deps = { db, fetch, now: () => NOW };
  on = await buildApp(loadEnv({ ...base, ACCESSIBLE_ROUTER_URL: "http://127.0.0.1:8002", ACCESSIBLE_ROUTER_WAYS_FILE: waysFile }), deps);
  noWays = await buildApp(loadEnv({ ...base, ACCESSIBLE_ROUTER_URL: "http://127.0.0.1:8002" }), deps);
  off = await buildApp(loadEnv(base), deps);
  await Promise.all([on.ready(), noWays.ready(), off.ready()]);
  halteId = (await placesNamed(db, "Halte contoh", 5)).find((p) => p.name === "Halte contoh")!.id;
}, 60_000);

afterAll(async () => {
  await Promise.all([on.close(), noWays.close(), off.close()]);
  await close();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  valhallaPath = found;
  fetch.mockClear();
});

let ip = 0;
const nextIp = () => `198.51.100.${(ip++ % 250) + 1}`;
const route = (payload: object, target = on, from = nextIp()) => target.inject({ method: "POST", url: "/route/accessible", payload, remoteAddress: from });

describe("POST /route/accessible", () => {
  it("returns a wheelchair route from OpenStreetMap with its data coverage and the fixed note", async () => {
    const res = await route({ from: nearHalte, placeId: halteId, profil: "kursi_roda" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body).toMatchObject({
      destination: { placeId: halteId, name: "Halte contoh" },
      profil: "kursi_roda",
      distanceMeters: 350,
      durationSeconds: 290,
      steps: [{ instruction: "Mulai berjalan ke arah barat", maneuver: "depart" }, { instruction: "Tiba di tujuan", maneuver: "arrive" }],
      geometry: { type: "LineString", coordinates: line },
      polyline: encodePolyline(line),
      coverage: { sidewalkPercent: 71, surfacePercent: 71, crossings: 0, crossingsWithKerb: 0, dataDate: "2026-11-25" },
      note: ACCESSIBLE_NOTE,
      attribution: expect.stringContaining("OpenStreetMap"),
    });
    expect(body.warnings.map((w: { code: string }) => w.code)).toEqual(["data_trotoar_kurang", "data_permukaan_kurang", "kemiringan_tidak_dihitung"]);
    expect(body).not.toHaveProperty("warning");
  });

  it("sends only the rounded start point to Valhalla and nothing to Mapbox", async () => {
    await route({ from: nearHalte, placeId: halteId, profil: "jalan_kaki" });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(["http://127.0.0.1:8002/route", "http://127.0.0.1:8002/trace_attributes"]);
    const sent = JSON.parse(String(fetch.mock.calls[0]![1]!.body)) as { locations: unknown[]; costing_options: { pedestrian: { type: string } } };
    expect(sent.locations[0]).toEqual({ lat: -6.5965, lon: 106.7972 });
    expect(sent.costing_options.pedestrian.type).toBe("foot");
  });

  it("says when no wheelchair path exists instead of falling back to Mapbox", async () => {
    valhallaPath = { status: 400, body: { error_code: 442, error: "No path could be found for input" } };
    const res = await route({ from: nearHalte, placeId: halteId, profil: "kursi_roda" });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ galat: "tanpa_rute_kursi_roda", pesan: expect.stringContaining("tanpa tangga") });
    expect(fetch.mock.calls.every(([url]) => String(url).startsWith("http://127.0.0.1:8002/"))).toBe(true);
  });

  it("asks for a start point near a path and reports a broken router", async () => {
    valhallaPath = { status: 400, body: { error_code: 171 } };
    expect((await route({ from: nearHalte, placeId: halteId, profil: "jalan_kaki" })).json().galat).toBe("jauh_dari_jalur");
    valhallaPath = { status: 500, body: {} };
    const res = await route({ from: nearHalte, placeId: halteId, profil: "jalan_kaki" });
    expect(res.statusCode).toBe(502);
    expect(res.json().galat).toBe("rute_gagal");
  });

  it("reports unknown coverage when the ways file is not set", async () => {
    const res = await route({ from: nearHalte, placeId: halteId, profil: "kursi_roda" }, noWays);
    expect(res.statusCode).toBe(200);
    expect(res.json().coverage).toEqual({ sidewalkPercent: null, surfacePercent: null, crossings: null, crossingsWithKerb: null, dataDate: null });
    expect(res.json().warnings[0].code).toBe("cakupan_tidak_diketahui");
  });

  it("is off without ACCESSIBLE_ROUTER_URL and leaves the Mapbox route alone", async () => {
    const res = await route({ from: nearHalte, placeId: halteId, profil: "kursi_roda" }, off);
    expect(res.statusCode).toBe(503);
    expect(res.json().galat).toBe("rute_aksesibel_belum_aktif");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks the body and the start point like the walking route", async () => {
    expect((await route({ from: nearHalte, placeId: halteId })).statusCode).toBe(400);
    expect((await route({ from: nearHalte, placeId: halteId, profil: "sepeda" })).statusCode).toBe(400);
    const outside = await route({ from: { lat: -6.2, lng: 106.82 }, placeId: halteId, profil: "kursi_roda" });
    expect(outside.statusCode).toBe(422);
    expect(outside.json().galat).toBe("di_luar_kota_bogor");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("limits accessible routes per IP", async () => {
    const from = nextIp();
    for (let i = 0; i < ACCESSIBLE_ROUTES_PER_HOUR; i += 1) expect((await route({ from: nearHalte, placeId: halteId, profil: "jalan_kaki" }, on, from)).statusCode).toBe(200);
    const over = await route({ from: nearHalte, placeId: halteId, profil: "jalan_kaki" }, on, from);
    expect(over.statusCode).toBe(429);
    expect(over.json().galat).toBe("agen_terlalu_sering");
  });
});
