import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import type { Db } from "../src/db/client.js";
import { seedSampleData } from "../src/db/seed.js";
import type { Email, Mailer } from "../src/email/mailer.js";
import { parseOverpass } from "../src/knowledge/osm.js";
import { loadOsm } from "../src/knowledge/osm-store.js";
import { insertPassages, replaceSource } from "../src/knowledge/store.js";
import { AGENT_CALLS_PER_HOUR, WALKING_ROUTES_PER_HOUR } from "../src/routes/agent.js";
import { accounts } from "./helpers/accounts.js";
import { createTestDb } from "./helpers/db.js";

const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test@localhost/test",
  BETTER_AUTH_SECRET: "rahasia-tes-yang-panjangnya-lebih-dari-32-karakter",
  MAPBOX_SECRET_TOKEN: "sk.rahasia",
  MAPBOX_USERNAME: "aksesbogor",
};
const NOW = new Date("2026-11-16T05:00:00.000Z");
const line: [number, number][] = [
  [106.7972, -6.5965],
  [106.7955, -6.596],
  [106.7942, -6.5958],
];
const directions = () =>
  Response.json({
    code: "Ok",
    routes: [
      {
        distance: 352,
        duration: 254,
        geometry: { type: "LineString", coordinates: line },
        legs: [{ steps: [{ distance: 352, duration: 254, name: "Jalan Contoh", maneuver: { type: "depart", instruction: "Berjalan ke barat", location: line[0] } }] }],
      },
    ],
  });

let db: Db;
let close: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let disabled: Awaited<ReturnType<typeof buildApp>>;
let sari: { token: string };
let budi: { token: string };
let halteId: string;
const fetch = vi.fn<typeof globalThis.fetch>(async () => directions());
const sent: Email[] = [];
const mailer: Mailer = async (email) => {
  sent.push(email);
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedSampleData(db);
  await loadOsm(
    db,
    parseOverpass({ elements: [{ type: "node", id: 2, lat: -6.5965, lon: 106.7971, tags: { kerb: "raised" } }] }),
    { url: "https://overpass-api.de/api/interpreter", retrievedAt: NOW, sha256: "c".repeat(64) },
  );
  const source = { id: "uu-8-2016", kind: "regulasi" as const, title: "UU No. 8 Tahun 2016", url: "https://peraturan.go.id/files/uu8-2016bt.pdf", license: "Tanpa hak cipta", retrievedAt: NOW };
  await replaceSource(db, source, (tx) => insertPassages(tx, source.id, [{ citation: "UU No. 8 Tahun 2016, Pasal 18", body: "Hak Aksesibilitas untuk fasilitas publik." }]));
  app = await buildApp(loadEnv({ ...base, ROUTE_AGENT_ENABLED: "true" }), { db, mailer, fetch, now: () => NOW });
  disabled = await buildApp(loadEnv(base), { db, mailer, fetch, now: () => NOW });
  await Promise.all([app.ready(), disabled.ready()]);
  const helpers = accounts(app, sent);
  sari = await helpers.reporter("sari@contoh.id", "Sari");
  budi = await helpers.reporter("budi@contoh.id", "Budi");
  const found = await call("find_place", sari.token, { query: "Halte contoh" });
  halteId = found.json().places.find((p: { name: string }) => p.name === "Halte contoh").id;
}, 60_000);

afterAll(async () => {
  await Promise.all([app.close(), disabled.close()]);
  await close();
});

let ip = 0;
/** Alamat klien berganti supaya batas global per IP (120 per menit) tidak ikut terpakai. */
const post = (url: string, token: string | null, payload: object, target = app) =>
  target.inject({ method: "POST", url, payload, headers: token ? { authorization: `Bearer ${token}` } : {}, remoteAddress: `198.51.100.${(ip++ % 250) + 1}` });
const call = (tool: string, token: string | null, payload: object, target = app) => post(`/agent/tools/${tool}`, token, payload, target);
const from = { lat: -6.5965, lng: 106.7972 };

describe("access", () => {
  it("stays closed while ROUTE_AGENT_ENABLED is off, for tools and app routes alike", async () => {
    for (const res of [
      await call("find_place", sari.token, { query: "halte" }, disabled),
      await post("/route/walking", sari.token, { from, placeId: halteId }, disabled),
      await post("/route/obstacles", sari.token, { polyline: "_ibE_seK_seK_seK" }, disabled),
    ]) {
      expect(res.statusCode).toBe(503);
      expect(res.json().galat).toBe("agen_rute_belum_aktif");
    }
  });

  it("needs a session", async () => {
    for (const res of [await call("find_place", null, { query: "halte" }), await post("/route/walking", null, { from, placeId: halteId })]) {
      expect(res.statusCode).toBe(401);
      expect(res.json().galat).toBe("belum_masuk");
    }
  });

  it("needs a completed account", async () => {
    const newcomer = await accounts(app, sent).signIn("baru@contoh.id");
    const res = await call("find_place", newcomer.token, { query: "halte" });
    expect(res.statusCode).toBe(403);
    expect(res.json().galat).toBe("akun_belum_lengkap");
  });

  it("rejects input that does not match the schema", async () => {
    for (const res of [await call("place_accessibility", sari.token, { placeId: "bukan-uuid" }), await post("/route/walking", sari.token, { from: { lat: -6.6 }, placeId: halteId })]) {
      expect(res.statusCode).toBe(400);
      expect(res.json().galat).toBe("input_tidak_valid");
    }
  });

  it("serves no route or obstacle tool to the model side", async () => {
    expect((await call("walking_route", sari.token, { from, placeId: halteId })).statusCode).toBe(404);
    expect((await call("route_obstacles", sari.token, { polyline: "_ibE_seK_seK_seK" })).statusCode).toBe(404);
  });
});

describe("GET /agent/tools", () => {
  it("lists the three model tools as an OpenAI-style tools array", async () => {
    const res = await app.inject({ method: "GET", url: "/agent/tools", headers: { authorization: `Bearer ${sari.token}` } });
    expect(res.statusCode).toBe(200);
    const { tools } = res.json() as { tools: { type: string; function: { name: string; description: string; parameters: { type: string; required: string[]; $schema?: string } } }[] };
    expect(tools.map((t) => t.function.name)).toEqual(["find_place", "place_accessibility", "search_knowledge"]);
    expect(tools.every((t) => t.type === "function" && t.function.description.length > 40 && !t.function.parameters.$schema)).toBe(true);
    expect(tools.find((t) => t.function.name === "place_accessibility")!.function.parameters).toMatchObject({ type: "object", required: ["placeId"] });
  });
});

describe("tools over HTTP", () => {
  it("answers find_place, place_accessibility and search_knowledge", async () => {
    const place = await call("place_accessibility", sari.token, { placeId: halteId });
    expect(place.statusCode).toBe(200);
    expect(place.headers["cache-control"]).toBe("no-store");
    expect(place.json()).toMatchObject({ name: "Halte contoh", status: "sebagian", lastVerifiedAt: "2026-10-18T03:00:00.000Z" });
    expect(place.json()).not.toHaveProperty("location");
    const knowledge = await call("search_knowledge", sari.token, { query: "hak aksesibilitas", kinds: ["regulasi"] });
    expect(knowledge.json().passages[0]).toMatchObject({ citation: "UU No. 8 Tahun 2016, Pasal 18", source: { kind: "regulasi" } });
  });

  it("answers 404 for a place that does not exist", async () => {
    const res = await call("place_accessibility", sari.token, { placeId: "00000000-0000-4000-8000-000000000000" });
    expect(res.statusCode).toBe(404);
  });
});

describe("app routes", () => {
  it("chains the walking route into the route obstacles without exposing the Mapbox token", async () => {
    const route = await post("/route/walking", sari.token, { from: { lat: -6.59651, lng: 106.79719 }, placeId: halteId });
    expect(route.statusCode).toBe(200);
    expect(route.headers["cache-control"]).toBe("no-store");
    expect(route.body).not.toContain("sk.rahasia");
    expect(route.json()).toMatchObject({ distanceMeters: 352, durationSeconds: 254, destination: { name: "Halte contoh" }, attribution: "© Mapbox © OpenStreetMap" });
    expect(route.json().warning).toContain("belum tentu bisa dilewati kursi roda");
    expect(String(fetch.mock.calls.at(-1)![0])).toContain("/walking/106.7972,-6.5965;");
    const obstacles = await post("/route/obstacles", sari.token, { polyline: route.json().polyline });
    expect(obstacles.statusCode).toBe(200);
    expect(obstacles.json().features).toMatchObject([{ kind: "kerb", description: "Kerb tinggi", osm: { url: "https://www.openstreetmap.org/node/2" } }]);
    expect(obstacles.json().attribution).toContain("OpenStreetMap");
  });

  it("refuses a start point outside Kota Bogor", async () => {
    const res = await post("/route/walking", sari.token, { from: { lat: -6.2, lng: 106.82 }, placeId: halteId });
    expect(res.statusCode).toBe(422);
    expect(res.json().galat).toBe("di_luar_kota_bogor");
  });
});

describe("per-account limits", () => {
  it("limits walking routes per account without affecting other accounts", async () => {
    fetch.mockClear();
    const results: number[] = [];
    // Sari sudah memakai dua rute di tes sebelumnya: satu berhasil, satu ditolak karena di luar Kota Bogor.
    for (let i = 0; i < WALKING_ROUTES_PER_HOUR - 2; i += 1) results.push((await post("/route/walking", sari.token, { from, placeId: halteId })).statusCode);
    expect(results.every((s) => s === 200)).toBe(true);
    const refused = await post("/route/walking", sari.token, { from, placeId: halteId });
    expect(refused.statusCode).toBe(429);
    expect(refused.json().galat).toBe("agen_terlalu_sering");
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    expect(fetch).toHaveBeenCalledTimes(WALKING_ROUTES_PER_HOUR - 2);
    expect((await post("/route/walking", budi.token, { from, placeId: halteId })).statusCode).toBe(200);
  });

  it("limits tool calls and app routes together per account", async () => {
    let status = 200;
    let calls = 0;
    while (status === 200 && calls <= AGENT_CALLS_PER_HOUR) {
      status = (await call("find_place", budi.token, { query: "halte" })).statusCode;
      calls += 1;
    }
    expect(status).toBe(429);
    // Budi sudah memakai satu rute jalan kaki di tes sebelumnya.
    expect(calls).toBe(AGENT_CALLS_PER_HOUR);
  });
});
