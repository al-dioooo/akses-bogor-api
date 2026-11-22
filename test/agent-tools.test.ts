import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findPlace, findPlacesToContribute, kecamatanPriorityTool, placeAccessibility, searchKnowledgeTool, type ToolContext } from "../src/agent/tools.js";
import { loadDisabilityCounts, parseDisabilityCounts } from "../src/contribute/disability.js";
import { loadFacilities, parseFacilities } from "../src/contribute/facilities.js";
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
    expect(places[0]).toMatchObject({ category: "halte", district: { slug: expect.any(String) } });
    expect(places[0]).not.toHaveProperty("location");
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
    expect(place).not.toHaveProperty("location");
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

describe("contributor tools", () => {
  const raw = { url: "https://overpass-api.de/api/interpreter", retrievedAt: now(), sha256: "c".repeat(64) };
  const slugs = ["bogor-barat", "bogor-selatan", "bogor-tengah", "bogor-timur", "bogor-utara", "tanah-sareal"];

  beforeAll(async () => {
    // Dua tempat tanpa data di Bogor Timur dan satu di Bogor Barat; Bogor Barat punya penyandang disabilitas terdaftar terbanyak.
    await loadFacilities(
      db,
      parseFacilities({
        elements: [
          { type: "node", id: 21, lat: -6.6055, lon: 106.8135, tags: { amenity: "place_of_worship", religion: "muslim", name: "Masjid Timur 1" } },
          { type: "node", id: 22, lat: -6.6058, lon: 106.8138, tags: { amenity: "place_of_worship", religion: "muslim", name: "Masjid Timur 2" } },
          { type: "node", id: 23, lat: -6.5705, lon: 106.7645, tags: { amenity: "hospital", name: "RS Barat" } },
        ],
      }),
      raw,
    );
    const rows = slugs.map((slug) => ({ bps_nama_kecamatan: slug.replace("-", " ").toUpperCase(), jenis_disabilitas: "CACAT TUBUH", jumlah: slug === "bogor-barat" ? 50 : 5, tahun: 2024 }));
    await loadDisabilityCounts(db, parseDisabilityCounts({ data: rows }, slugs), raw);
  });

  it("orders places by missing data while the disability data is closed, and never returns coordinates", async () => {
    const result = await findPlacesToContribute(context(), {});
    expect(result.order).toBe("tempat_tanpa_data_terbanyak");
    expect(result.places.map((p) => p.name)).toEqual(["Masjid Timur 1", "Masjid Timur 2", "RS Barat"]);
    expect(result.places[0]).toEqual({ osm: { osmType: "node", osmId: 21 }, name: "Masjid Timur 1", category: "masjid", district: { slug: "bogor-timur", name: "Bogor Timur" }, priorityRank: null });
    expect(JSON.stringify(result)).not.toMatch(/"(lat|lng|location)"/);
    await expect(kecamatanPriorityTool(context())).rejects.toMatchObject({ statusCode: 503, code: "data_disabilitas_belum_aktif" });
  });

  it("orders places by kecamatan priority once the disability data is open", async () => {
    const open = { db, now, disabilityData: true };
    const result = await findPlacesToContribute(open, { limit: 2 });
    expect(result.order).toBe("prioritas_kecamatan");
    expect(result.places.map((p) => [p.name, p.priorityRank])).toEqual([
      ["RS Barat", 1],
      ["Masjid Timur 1", expect.any(Number)],
    ]);
    expect((await findPlacesToContribute(open, { kecamatan: "bogor-timur", category: "masjid" })).places).toHaveLength(2);
    const priority = await kecamatanPriorityTool(open);
    expect(priority.districts[0]).toMatchObject({ slug: "bogor-barat", rank: 1 });
  });
});
