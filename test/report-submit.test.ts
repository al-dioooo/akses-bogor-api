import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import type { Db } from "../src/db/client.js";
import { seedSampleData } from "../src/db/seed.js";
import type { Email, Mailer } from "../src/email/mailer.js";
import type { PhotoStore } from "../src/photos/storage.js";
import { accounts } from "./helpers/accounts.js";
import { createTestDb } from "./helpers/db.js";
import { png } from "./helpers/photos.js";

const env = loadEnv({ NODE_ENV: "test", DATABASE_URL: "postgresql://test@localhost/test", BETTER_AUTH_SECRET: "rahasia-tes-yang-panjangnya-lebih-dari-32-karakter" });
const NOW = new Date("2026-11-07T10:00:00.000Z");
const store: PhotoStore = { put: async () => {}, remove: async () => {} };

let db: Db;
let close: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let helpers: ReturnType<typeof accounts>;
let sari: { token: string };
const sent: Email[] = [];
const mailer: Mailer = async (email) => {
  sent.push(email);
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedSampleData(db);
  app = await buildApp(env, { db, mailer, photoStore: store, now: () => NOW });
  await app.ready();
  helpers = accounts(app, sent);
  sari = await helpers.reporter("sari@contoh.id", "Sari");
}, 60_000);

afterAll(async () => {
  await app.close();
  await close();
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const facilities = ["ramp", "toilet_difabel", "guiding_block", "lift"].map((facility) => ({ facility, answer: "belum_tahu" }));
const newPlace = (extra: object = {}) => ({
  submissionKey: crypto.randomUUID(),
  kind: "baru",
  name: "Masjid Al-Ikhlas contoh",
  category: "masjid",
  location: { lat: -6.5976, lng: 106.7991 },
  facilities,
  ...extra,
});
const send = (token: string | null, payload: object) => app.inject({ method: "POST", url: "/reports", payload, headers: token ? bearer(token) : {} });

describe("POST /reports", () => {
  it("queues the report with its uploaded photo and lists it in Laporan saya as waiting", async () => {
    const upload = await app.inject({ method: "POST", url: "/reports/photos", payload: await png(), headers: { "content-type": "image/png", ...bearer(sari.token) } });
    const res = await send(sari.token, newPlace({ photos: [{ id: upload.json().id, tag: "pintu_masuk" }] }));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ kind: "baru", status: "menunggu", name: "Masjid Al-Ikhlas contoh", district: { slug: "bogor-tengah" }, photos: 1 });
    const mine = await app.inject({ method: "GET", url: "/me/reports", headers: bearer(sari.token) });
    expect(mine.json().items[0]).toMatchObject({ id: res.json().id, kind: "baru", status: "menunggu", placeName: "Masjid Al-Ikhlas contoh" });
  });

  it("answers a repeated draft with the same report", async () => {
    const payload = newPlace({ name: "Kampus contoh C" });
    const [first, again] = [await send(sari.token, payload), await send(sari.token, payload)];
    expect([first.statusCode, again.statusCode]).toEqual([201, 201]);
    expect(again.json()).toEqual(first.json());
  });

  it("answers 400 for an invalid form and 422 outside Kota Bogor", async () => {
    const invalid = await send(sari.token, newPlace({ facilities: facilities.slice(0, 3) }));
    expect([invalid.statusCode, invalid.json().galat]).toEqual([400, "input_tidak_valid"]);
    const outside = await send(sari.token, newPlace({ location: { lat: -6.5579, lng: 106.7268 } }));
    expect([outside.statusCode, outside.json().galat]).toEqual([422, "di_luar_kota_bogor"]);
  });

  it("needs a session and a completed account", async () => {
    expect((await send(null, newPlace())).statusCode).toBe(401);
    const incomplete = await helpers.signIn("baru@contoh.id");
    const res = await send(incomplete.token, newPlace());
    expect([res.statusCode, res.json().galat]).toEqual([403, "akun_belum_lengkap"]);
  });
});
