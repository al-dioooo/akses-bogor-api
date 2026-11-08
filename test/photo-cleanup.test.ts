import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { deleteAccount } from "../src/auth/delete-account.js";
import type { Db } from "../src/db/client.js";
import { photoDeletions, photos, reports, users } from "../src/db/schema.js";
import { cleanUpPhotos } from "../src/photos/cleanup.js";
import type { PhotoStore } from "../src/photos/storage.js";
import { createTestDb } from "./helpers/db.js";

const NOW = new Date("2026-11-07T10:00:00.000Z");
const HOUR = 3600_000;

/** Penyimpanan di memori; `failing` membuat remove gagal. */
const files = new Set<string>();
const failing = { remove: false };
const store: PhotoStore = {
  async put(key) {
    files.add(key);
  },
  async get() {
    return new Uint8Array();
  },
  async remove(key) {
    if (failing.remove) throw new Error("R2 menjawab 500");
    files.delete(key);
  },
};

let db: Db;
let close: () => Promise<void>;
let userId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  [{ id: userId }] = (await db.insert(users).values({ displayName: "Pelapor", email: "pelapor@contoh.id" }).returning({ id: users.id })) as [{ id: string }];
}, 60_000);

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await db.delete(photos);
  await db.delete(photoDeletions);
  files.clear();
});

/** Unggahan yang belum dipasang ke laporan, dibuat `hoursAgo` jam sebelum NOW. */
async function upload(uploaderId: string, hoursAgo: number) {
  const id = crypto.randomUUID();
  const storageKey = `laporan/${id}.webp`;
  await db.insert(photos).values({ id, uploaderId, storageKey, altText: "", width: 10, height: 10, bytes: 100, createdAt: new Date(NOW.getTime() - hoursAgo * HOUR) });
  files.add(storageKey);
  return { id, storageKey };
}

describe("cleanUpPhotos", () => {
  it("deletes uploads that were never attached after 24 hours, then their files", async () => {
    const old = await upload(userId, 25);
    const fresh = await upload(userId, 23);
    expect(await cleanUpPhotos(db, store, NOW)).toEqual({ expired: 1, removed: 1, failed: 0 });
    expect((await db.select({ id: photos.id }).from(photos)).map((p) => p.id)).toEqual([fresh.id]);
    expect(files.has(old.storageKey)).toBe(false);
    expect(files.has(fresh.storageKey)).toBe(true);
    expect(await db.select().from(photoDeletions)).toEqual([]);
  });

  it("keeps attached photos however old they are", async () => {
    const [report] = await db.insert(reports).values({ kind: "baru", submission: {}, reporterId: userId }).returning({ id: reports.id });
    await db.insert(photos).values({ reportId: report!.id, storageKey: "laporan/terpasang.webp", altText: "Foto", width: 10, height: 10, bytes: 100, createdAt: new Date(0) });
    expect((await cleanUpPhotos(db, store, NOW)).expired).toBe(0);
    expect(await db.select().from(photos)).toHaveLength(1);
    await db.delete(reports);
  });

  it("keeps a deletion queued when the file cannot be removed yet", async () => {
    await db.insert(photoDeletions).values({ storageKey: "laporan/tertunda.webp" });
    failing.remove = true;
    expect(await cleanUpPhotos(db, store, NOW)).toEqual({ expired: 0, removed: 0, failed: 1 });
    failing.remove = false;
    expect(await db.select().from(photoDeletions)).toHaveLength(1);
    expect((await cleanUpPhotos(db, store, NOW)).removed).toBe(1);
    expect(await db.select().from(photoDeletions)).toEqual([]);
  });

  it("keeps the queue while no store is configured", async () => {
    await upload(userId, 30);
    expect(await cleanUpPhotos(db, undefined, NOW)).toEqual({ expired: 1, removed: 0, failed: 0 });
    expect(await db.select().from(photoDeletions)).toHaveLength(1);
  });
});

describe("account deletion (ADR-0024)", () => {
  it("queues uploads that were never attached to a report", async () => {
    const [leaving] = await db.insert(users).values({ displayName: "Pergi", email: "pergi@contoh.id" }).returning({ id: users.id });
    const { id, storageKey } = await upload(leaving!.id, 1);
    const kept = await upload(userId, 1);
    await deleteAccount(db, leaving!.id);
    expect(await db.select().from(photos).where(eq(photos.id, id))).toEqual([]);
    expect(await db.select().from(photos).where(eq(photos.id, kept.id))).toHaveLength(1);
    expect(await db.select({ storageKey: photoDeletions.storageKey }).from(photoDeletions)).toEqual([{ storageKey }]);
  });
});
