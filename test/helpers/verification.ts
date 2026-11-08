// Rangkaian tes verifikasi: aplikasi dengan data contoh, penyimpanan foto di memori, jam yang bisa dimajukan, dan akun
// pelapor serta verifikator yang masuk lewat route sungguhan.
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { loadEnv } from "../../src/config/env.js";
import { places, users } from "../../src/db/schema.js";
import { seedSampleData } from "../../src/db/seed.js";
import type { Email, Mailer } from "../../src/email/mailer.js";
import type { PhotoStore } from "../../src/photos/storage.js";
import { accounts } from "./accounts.js";
import { createTestDb } from "./db.js";
import { png } from "./photos.js";

export const env = loadEnv({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test@localhost/test",
  BETTER_AUTH_SECRET: "rahasia-tes-yang-panjangnya-lebih-dari-32-karakter",
  PHOTO_PUBLIC_URL: "https://foto.contoh.id",
  FRONTEND_ORIGINS: "https://akses-bogor.contoh.id",
});

/** Penyimpanan di memori; `failing` membuat operasi tertentu gagal. */
export function memoryStore() {
  const files = new Map<string, { data: Uint8Array; contentType: string }>();
  const failing = { put: false, get: false, remove: false };
  const store: PhotoStore = {
    async put(key, data, contentType) {
      if (failing.put) throw new Error("R2 menjawab 500");
      files.set(key, { data, contentType });
    },
    async get(key) {
      if (failing.get) throw new Error("R2 menjawab 500");
      const file = files.get(key);
      if (!file) throw new Error(`berkas ${key} tidak ada`);
      return file.data;
    },
    async remove(key) {
      if (failing.remove) throw new Error("R2 menjawab 500");
      files.delete(key);
    },
  };
  return { store, files, failing };
}

export const facilities = (overrides: Record<string, object> = {}) =>
  ["ramp", "toilet_difabel", "guiding_block", "lift"].map((facility) => ({ facility, answer: "belum_tahu", ...overrides[facility] }));

export async function verificationRig(start = new Date("2026-11-08T03:00:00.000Z")) {
  const { db, close } = await createTestDb();
  await seedSampleData(db);
  const clock = { now: start };
  const memory = memoryStore();
  const sent: Email[] = [];
  const mail = { failing: false };
  const mailer: Mailer = async (email) => {
    if (mail.failing) throw new Error("Resend menjawab 500");
    sent.push(email);
  };
  const app = await buildApp(env, { db, mailer, photoStore: memory.store, now: () => clock.now });
  await app.ready();
  const helpers = accounts(app, sent);

  let ip = 1;
  /** Header sesi dengan alamat klien berbeda per permintaan, supaya batas umum 120 per menit tidak tercapai. */
  const as = (token: string) => ({ authorization: `Bearer ${token}`, "x-forwarded-for": `203.0.113.${ip++ % 250}` });

  async function verifier(email: string, displayName = "Verifikator", role: "verifikator" | "admin" = "verifikator") {
    const session = await helpers.reporter(email, displayName);
    await db.update(users).set({ role }).where(eq(users.id, session.user.id));
    return session;
  }

  async function uploadPhoto(token: string) {
    const res = await app.inject({ method: "POST", url: "/reports/photos", payload: await png(400, 300), headers: { ...as(token), "content-type": "image/png" } });
    if (res.statusCode !== 201) throw new Error(`unggah foto gagal: ${res.body}`);
    return (res.json() as { id: string }).id;
  }

  async function submit(token: string, payload: Record<string, unknown>) {
    const res = await app.inject({ method: "POST", url: "/reports", headers: as(token), payload: { submissionKey: crypto.randomUUID(), facilities: facilities(), ...payload } });
    if (res.statusCode !== 201) throw new Error(`kirim laporan gagal: ${res.body}`);
    return (res.json() as { id: string }).id;
  }

  const newPlace = (extra: Record<string, unknown> = {}) => ({
    kind: "baru",
    name: "Masjid Al-Ikhlas contoh",
    category: "masjid",
    location: { lat: -6.5976, lng: 106.7991 },
    ...extra,
  });

  const placeId = async (name: string) => (await db.select({ id: places.id }).from(places).where(eq(places.name, name)))[0]!.id;

  return { db, app, clock, memory, sent, mail, helpers, as, verifier, uploadPhoto, submit, newPlace, placeId, close: async () => (await app.close(), await close()) };
}

export type Rig = Awaited<ReturnType<typeof verificationRig>>;
