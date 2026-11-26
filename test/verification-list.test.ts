import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { places } from "../src/db/schema.js";
import { listUnverified, readOnly, toCsv, type ListRow } from "../src/hints/verification-list.js";
import { ATTAQWA, KESATUAN, PMI, ref, SILOAM, streetViewRig } from "./helpers/street-view.js";

let rig: Awaited<ReturnType<typeof streetViewRig>>;
let rows: ListRow[];
let counts: Map<string, number>;

beforeAll(async () => {
  rig = await streetViewRig();
  ({ rows, counts } = await listUnverified(rig.db));
}, 90_000);

afterAll(async () => {
  await rig.close();
});

const of = (jenis: ListRow["jenis"]) => rows.filter((r) => r.jenis === jenis);

describe("listUnverified (ADR-0057)", () => {
  it("lists every unchecked hint copy with its claim, and skips copies already checked by the team", () => {
    expect(of("petunjuk_google").map((r) => r.id)).toEqual([ref(SILOAM), ref(PMI)].sort());
    expect(of("petunjuk_osm").map((r) => r.id).sort()).toEqual([ref(ATTAQWA), ref(PMI)].sort());
    expect(rows.some((r) => r.id === ref(KESATUAN) && r.jenis.startsWith("petunjuk"))).toBe(false);
    expect(of("petunjuk_google").find((r) => r.id === ref(SILOAM))).toMatchObject({
      status: "belum_diperiksa_tim",
      nama: "Siloam Hospitals Bogor",
      kategori: "rumah_sakit",
      kecamatan: "Bogor Tengah",
      klaim: "ada: Pintu masuk khusus pengguna kursi roda; tidak ada: Toilet khusus pengguna kursi roda",
      tayangDiPeta: true,
    });
    expect(of("petunjuk_osm").find((r) => r.id === ref(ATTAQWA))!.klaim).toBe("wheelchair=yes");
  });

  it("lists admin-published places with their answers", () => {
    expect(of("tempat_admin")).toEqual([expect.objectContaining({ id: rig.adminPlaceId, nama: "Rumah sakit contoh", klaim: "ramp=tersedia; toilet_difabel=tersedia; guiding_block=tersedia; lift=tersedia" })]);
  });

  it("lists pending reports as id, kind and status only", () => {
    const reports = of("laporan");
    expect(reports.map((r) => `${r.status}:${r.klaim}`).sort()).toEqual(["klarifikasi:perubahan", "menunggu:baru"]);
    for (const r of reports) expect(r).toMatchObject({ nama: null, kategori: null, kecamatan: null, lat: null, lng: null, tayangDiPeta: null });
    const csv = toCsv(rows);
    expect(csv).not.toContain("Isian rahasia warga");
    expect(csv).not.toContain("Teks bebas warga");
    expect(csv).not.toContain("warga@contoh.id");
    expect(csv).not.toContain("Warga Bogor");
  });

  it("lists the OSM candidates shown on the map, with their own wheelchair tag", () => {
    expect(of("kandidat").map((r) => r.id).sort()).toEqual([ref(ATTAQWA), ref(KESATUAN), ref(PMI), ref(SILOAM)].sort());
    expect(of("kandidat").find((r) => r.id === ref(KESATUAN))!.klaim).toBe("wheelchair=no");
  });

  it("counts each kind and each kind by status", () => {
    expect(Object.fromEntries(["petunjuk_google", "petunjuk_osm", "tempat_admin", "laporan", "kandidat", "laporan/menunggu", "laporan/klarifikasi"].map((k) => [k, counts.get(k)]))).toEqual({
      petunjuk_google: 2,
      petunjuk_osm: 2,
      tempat_admin: 1,
      laporan: 2,
      kandidat: 4,
      "laporan/menunggu": 1,
      "laporan/klarifikasi": 1,
    });
  });

  it("refuses any write inside the read-only transaction", async () => {
    await expect(readOnly(rig.db, (tx) => tx.update(places).set({ name: "Ditimpa" }).where(sql`true`))).rejects.toThrow();
    expect((await rig.db.select({ name: places.name }).from(places)).some((p) => p.name === "Ditimpa")).toBe(false);
  });
});

describe("toCsv", () => {
  const row: ListRow = { jenis: "kandidat", id: "node/1", status: "tayang", nama: '=HYPERLINK("x"), "Masjid"', kategori: "masjid", kecamatan: "Bogor Barat", lat: -6.5, lng: 106.8, klaim: null, tayangDiPeta: true };

  it("writes a header, quotes cells with commas or quotes, and defuses spreadsheet formulas", () => {
    const [header, line] = toCsv([row]).trimEnd().split("\n");
    expect(header).toBe("jenis,id,status,nama,kategori,kecamatan,lat,lng,klaim,tayang_di_peta");
    expect(line).toBe(`kandidat,node/1,tayang,"'=HYPERLINK(""x""), ""Masjid""",masjid,Bogor Barat,-6.5000000,106.8000000,,true`);
  });
});
