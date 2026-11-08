import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import type { Db } from "../src/db/client.js";
import { photos } from "../src/db/schema.js";
import type { Email, Mailer } from "../src/email/mailer.js";
import { MAX_PHOTO_BYTES } from "../src/photos/process.js";
import type { PhotoStore } from "../src/photos/storage.js";
import { PHOTO_UPLOADS_PER_HOUR } from "../src/routes/reports.js";
import { accounts } from "./helpers/accounts.js";
import { createTestDb } from "./helpers/db.js";
import { jpegWithGps, png } from "./helpers/photos.js";

const env = loadEnv({ NODE_ENV: "test", DATABASE_URL: "postgresql://test@localhost/test", BETTER_AUTH_SECRET: "rahasia-tes-yang-panjangnya-lebih-dari-32-karakter" });
const NOW = new Date("2026-11-07T10:00:00.000Z");

/** Penyimpanan di memori; `failing` membuat put gagal. */
function memoryStore() {
  const files = new Map<string, { data: Uint8Array; contentType: string }>();
  const failing = { put: false };
  const store: PhotoStore = {
    async put(key, data, contentType) {
      if (failing.put) throw new Error("R2 menjawab 500");
      files.set(key, { data, contentType });
    },
    async remove(key) {
      files.delete(key);
    },
  };
  return { store, files, failing };
}

let db: Db;
let close: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let session: Awaited<ReturnType<ReturnType<typeof accounts>["reporter"]>>;
let helpers: ReturnType<typeof accounts>;
const memory = memoryStore();
const sent: Email[] = [];
const mailer: Mailer = async (email) => {
  sent.push(email);
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  app = await buildApp(env, { db, mailer, photoStore: memory.store, now: () => NOW });
  await app.ready();
  helpers = accounts(app, sent);
  session = await helpers.reporter("pelapor@contoh.id");
}, 60_000);

afterAll(async () => {
  await app.close();
  await close();
});

const upload = (token: string | null, body: Buffer, contentType = "image/jpeg") =>
  app.inject({
    method: "POST",
    url: "/reports/photos",
    payload: body,
    headers: { "content-type": contentType, ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });

describe("POST /reports/photos", () => {
  it("stores a webp without metadata in the private bucket and records the uploader", async () => {
    const res = await upload(session.token, await jpegWithGps(400, 300));
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toEqual({ id: expect.any(String), width: 300, height: 400, bytes: expect.any(Number) });
    const [row] = await db.select().from(photos).where(eq(photos.id, body.id));
    expect(row).toMatchObject({ reportId: null, uploaderId: session.user.id, storageKey: `laporan/${body.id}.webp`, width: 300, height: 400 });
    const file = memory.files.get(`laporan/${body.id}.webp`)!;
    expect(file.contentType).toBe("image/webp");
    expect((await sharp(file.data).metadata()).exif).toBeUndefined();
  });

  it("needs a session and a completed account", async () => {
    expect((await upload(null, await png())).statusCode).toBe(401);
    const incomplete = await helpers.signIn("belum-lengkap@contoh.id");
    const res = await upload(incomplete.token, await png());
    expect(res.statusCode).toBe(403);
    expect(res.json().galat).toBe("akun_belum_lengkap");
  });

  it("rejects other types, wrong headers, and files over 3 MB", async () => {
    const gif = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } }).gif().toBuffer();
    expect((await upload(session.token, gif, "image/jpeg")).json().galat).toBe("jenis_foto_tidak_didukung");
    const asText = await upload(session.token, await png(), "text/plain");
    expect([asText.statusCode, asText.json().galat]).toEqual([415, "jenis_foto_tidak_didukung"]);
    const big = await upload(session.token, Buffer.alloc(MAX_PHOTO_BYTES + 1, 0xff));
    expect([big.statusCode, big.json().galat]).toEqual([413, "foto_terlalu_besar"]);
  });

  it("removes the row again when the file cannot be stored", async () => {
    const before = await db.select({ id: photos.id }).from(photos);
    memory.failing.put = true;
    const res = await upload(session.token, await png());
    memory.failing.put = false;
    expect([res.statusCode, res.json().galat]).toEqual([502, "foto_gagal_disimpan"]);
    expect(await db.select({ id: photos.id }).from(photos)).toHaveLength(before.length);
  });

  it("answers 503 when photo storage is not configured", async () => {
    const bare = await buildApp(env, { db, mailer, now: () => NOW });
    const res = await bare.inject({ method: "POST", url: "/reports/photos", payload: await png(), headers: { "content-type": "image/png", authorization: `Bearer ${session.token}` } });
    expect([res.statusCode, res.json().galat]).toEqual([503, "foto_belum_diatur"]);
    await bare.close();
  });

  it(`allows ${PHOTO_UPLOADS_PER_HOUR} uploads per account per hour`, async () => {
    const busy = await helpers.reporter("sibuk@contoh.id");
    const tiny = await png(8, 8);
    for (let i = 0; i < PHOTO_UPLOADS_PER_HOUR; i++) expect((await upload(busy.token, tiny, "image/png")).statusCode).toBe(201);
    const res = await upload(busy.token, tiny, "image/png");
    expect([res.statusCode, res.json().galat]).toEqual([429, "foto_terlalu_sering"]);
    expect(res.headers["retry-after"]).toBeDefined();
    expect((await upload(session.token, tiny, "image/png")).statusCode).toBe(201);
  });
});
