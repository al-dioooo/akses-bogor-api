import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DISABILITY_SOURCE, loadDisabilityCounts, parseDisabilityCounts } from "../src/contribute/disability.js";
import type { Db } from "../src/db/client.js";
import { disabilityCounts, knowledgeSources } from "../src/db/schema.js";
import { seedSampleData } from "../src/db/seed.js";
import { createTestDb } from "./helpers/db.js";

const slugs = ["bogor-barat", "bogor-selatan", "bogor-tengah", "bogor-timur", "bogor-utara", "tanah-sareal"];
const row = (kecamatan: string, jenis: string, jumlah: number, tahun: number) => ({
  bps_nama_kecamatan: kecamatan,
  jenis_disabilitas: jenis,
  jumlah,
  tahun,
  satuan: "Orang",
  kemendagri_kode_kecamatan: "32.71.01",
});

describe("parseDisabilityCounts", () => {
  it("maps kecamatan names to slugs and source labels to AksesBogor categories", () => {
    const rows = parseDisabilityCounts(
      { data: [row("TANAH SAREAL", "CACAT TUBUH", 12, 2024), row("BOGOR BARAT", "CACAT NETRA", 3, 2024), row("BOGOR UTARA", "CACAT MENTAL", 0, 2023), row("BOGOR TIMUR", "CACAT LAINNYA", 5, 2022)] },
      slugs,
    );
    expect(rows).toEqual([
      { districtSlug: "tanah-sareal", year: 2024, category: "fisik", sourceLabel: "CACAT TUBUH", count: 12 },
      { districtSlug: "bogor-barat", year: 2024, category: "netra", sourceLabel: "CACAT NETRA", count: 3 },
      { districtSlug: "bogor-utara", year: 2023, category: "mental", sourceLabel: "CACAT MENTAL", count: 0 },
      { districtSlug: "bogor-timur", year: 2022, category: "lainnya", sourceLabel: "CACAT LAINNYA", count: 5 },
    ]);
  });

  it("rejects the whole response when the format changes", () => {
    expect(() => parseDisabilityCounts({ data: [] }, slugs)).toThrow(/kosong/);
    expect(() => parseDisabilityCounts({ data: [row("CIBINONG", "CACAT TUBUH", 1, 2024)] }, slugs)).toThrow(/kecamatan/);
    expect(() => parseDisabilityCounts({ data: [row("BOGOR BARAT", "TUNA RUNGU", 1, 2024)] }, slugs)).toThrow(/jenis/);
    expect(() => parseDisabilityCounts({ data: [row("BOGOR BARAT", "CACAT TUBUH", -1, 2024)] }, slugs)).toThrow(/jumlah/);
  });
});

describe("loadDisabilityCounts", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await seedSampleData(db);
  }, 60_000);

  afterAll(async () => {
    await close();
  });

  it("stores every row with its source, terms and retrieval date, and replaces them on a rerun", async () => {
    const raw = { retrievedAt: new Date("2026-11-22T09:37:00.000Z"), sha256: "d".repeat(64) };
    const first = parseDisabilityCounts({ data: [row("BOGOR BARAT", "CACAT TUBUH", 7, 2024), row("BOGOR BARAT", "CACAT NETRA", 2, 2024)] }, slugs);
    expect(await loadDisabilityCounts(db, first, raw)).toBe(2);
    expect(await loadDisabilityCounts(db, first.slice(0, 1), raw)).toBe(1);
    const stored = await db.select().from(disabilityCounts);
    expect(stored).toEqual([{ sourceId: DISABILITY_SOURCE.id, districtSlug: "bogor-barat", year: 2024, category: "fisik", sourceLabel: "CACAT TUBUH", count: 7 }]);
    const [source] = await db.select().from(knowledgeSources);
    expect(source).toMatchObject({ kind: "data_disabilitas", license: DISABILITY_SOURCE.terms, retrievedAt: raw.retrievedAt, sha256: raw.sha256 });
    expect(source!.license).toContain("pihak ketiga");
  });
});
