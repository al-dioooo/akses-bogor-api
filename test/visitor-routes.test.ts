import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import type { Db } from "../src/db/client.js";
import { seedSampleData } from "../src/db/seed.js";
import { placesNamed } from "../src/places/queries.js";
import { WALKING_ROUTES_PER_HOUR } from "../src/routes/agent.js";
import { createTestDb } from "./helpers/db.js";

const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test@localhost/test",
  BETTER_AUTH_SECRET: "rahasia-tes-yang-panjangnya-lebih-dari-32-karakter",
  MAPBOX_SECRET_TOKEN: "sk.rahasia",
  MAPBOX_USERNAME: "aksesbogor",
};
const NOW = new Date("2026-11-23T05:00:00.000Z");
/** Beberapa meter dari Halte contoh di Bogor Tengah. */
const nearHalte = { lat: -6.59585, lng: 106.79425 };
const line = [
  [106.7943, -6.5959],
  [106.7942, -6.5958],
];
const fetch = vi.fn<typeof globalThis.fetch>(async () =>
  Response.json({
    code: "Ok",
    routes: [{ distance: 20, duration: 15, geometry: { type: "LineString", coordinates: line }, legs: [{ steps: [{ distance: 20, duration: 15, name: "Jalan Contoh", maneuver: { type: "depart", instruction: "Berjalan ke barat", location: line[0] } }] }] }],
  }),
);

let db: Db;
let close: () => Promise<void>;
let open: Awaited<ReturnType<typeof buildApp>>;
let closed: Awaited<ReturnType<typeof buildApp>>;
let halteId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedSampleData(db);
  const deps = { db, fetch, now: () => NOW };
  open = await buildApp(loadEnv({ ...base, ROUTE_ASSISTANT_ENABLED: "true" }), deps);
  closed = await buildApp(loadEnv(base), deps);
  await Promise.all([open.ready(), closed.ready()]);
  halteId = (await placesNamed(db, "Halte contoh", 5)).find((p) => p.name === "Halte contoh")!.id;
}, 60_000);

afterAll(async () => {
  await Promise.all([open.close(), closed.close()]);
  await close();
});

let ip = 0;
const nextIp = () => `198.51.100.${(ip++ % 250) + 1}`;
const walk = (payload: object, target = open, from = nextIp()) => target.inject({ method: "POST", url: "/route/walking", payload, remoteAddress: from });

describe("walking routes for visitors of the public route assistant", () => {
  it("lets a visitor without an account route to an AksesBogor place and see the obstacles", async () => {
    const res = await walk({ from: nearHalte, placeId: halteId });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toMatchObject({ destination: { placeId: halteId }, warning: expect.stringContaining("kursi roda") });
    const obstacles = await open.inject({ method: "POST", url: "/route/obstacles", payload: { polyline: res.json().polyline }, remoteAddress: nextIp() });
    expect(obstacles.statusCode).toBe(200);
  });

  it("limits walking routes per IP", async () => {
    const from = nextIp();
    for (let i = 0; i < WALKING_ROUTES_PER_HOUR; i += 1) expect((await walk({ from: nearHalte, placeId: halteId }, open, from)).statusCode).toBe(200);
    const over = await walk({ from: nearHalte, placeId: halteId }, open, from);
    expect(over.statusCode).toBe(429);
    expect(over.json().galat).toBe("agen_terlalu_sering");
    expect((await walk({ from: nearHalte, placeId: halteId })).statusCode).toBe(200);
  });

  it("keeps OpenStreetMap destinations for signed-in contributors", async () => {
    const res = await walk({ from: nearHalte, osm: { type: "node", id: 1 } });
    expect(res.statusCode).toBe(503);
    expect(res.json().galat).toBe("agen_rute_belum_aktif");
  });

  it("stays closed to visitors while the assistant is off", async () => {
    const res = await walk({ from: nearHalte, placeId: halteId }, closed);
    expect(res.statusCode).toBe(503);
    expect(res.json().galat).toBe("agen_rute_belum_aktif");
    expect((await closed.inject({ method: "POST", url: "/route/obstacles", payload: { polyline: "abc" }, remoteAddress: nextIp() })).statusCode).toBe(503);
  });
});
