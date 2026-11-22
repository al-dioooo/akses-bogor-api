import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findPlace, placeAccessibility, searchKnowledgeTool, type ToolContext } from "../src/agent/tools.js";
import type { Db } from "../src/db/client.js";
import { seedSampleData } from "../src/db/seed.js";
import { insertPassages, replaceSource } from "../src/knowledge/store.js";
import { createTestDb } from "./helpers/db.js";

let db: Db;
let close: () => Promise<void>;
let halteId: string;
const now = () => new Date("2026-11-16T05:00:00.000Z");

const context = (): ToolContext => ({ db, now });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedSampleData(db);
  const source = { id: "uu-8-2016", kind: "regulasi" as const, title: "UU No. 8 Tahun 2016", url: "https://peraturan.go.id/files/uu8-2016bt.pdf", license: "Tanpa hak cipta", retrievedAt: now() };
  await replaceSource(db, source, (tx) => insertPassages(tx, source.id, [{ citation: "UU No. 8 Tahun 2016, Pasal 18", body: "Hak Aksesibilitas untuk fasilitas publik." }]));
  halteId = (await findPlace(context(), { query: "Halte contoh" })).places.find((p) => p.name === "Halte contoh")!.id;
}, 60_000);

afterAll(async () => {
  await close();
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

describe("search_knowledge", () => {
  it("returns passages with their citation and licence", async () => {
    const { passages } = await searchKnowledgeTool(context(), { query: "hak aksesibilitas" });
    expect(passages[0]).toMatchObject({ citation: "UU No. 8 Tahun 2016, Pasal 18", source: { license: "Tanpa hak cipta" } });
  });
});
