import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFacilities, parseFacilities } from "../src/contribute/facilities.js";
import type { Db } from "../src/db/client.js";
import { seedSampleData } from "../src/db/seed.js";
import { decide, GOOGLE_MAPS_TAG, googleCategories, IMPORT_METHOD, importGoogleMaps, parseApifyItems, summarize, type TagValue } from "../src/hints/google-maps-import.js";
import { storedGoogle } from "../src/hints/stored.js";
import { createTestDb } from "./helpers/db.js";

// Semua tempat dan hasil Google di sini palsu, hanya untuk tes, dan tidak pernah dimuat sebagai data.
// Di lintang Kota Bogor, 0,001° bujur ≈ 110 m.
const OSM = [
  { type: "node", id: 1, lat: -6.5705, lon: 106.7645, tags: { amenity: "place_of_worship", religion: "muslim", name: "Masjid Uji Coba Al-Palsu" } },
  { type: "node", id: 2, lat: -6.5705, lon: 106.7677, tags: { amenity: "place_of_worship", religion: "muslim", name: "Masjid Uji Coba Al-Palsu" } },
  { type: "node", id: 3, lat: -6.5958, lon: 106.7942, tags: { amenity: "hospital", name: "RS Contoh Palsu" } },
  { type: "node", id: 4, lat: -6.5958, lon: 106.796, tags: { highway: "bus_stop", name: "Halte Uji Coba Palsu" } },
  { type: "node", id: 5, lat: -6.59, lon: 106.8, tags: { amenity: "university", name: "Universitas Palsu Bogor" } },
  { type: "node", id: 6, lat: -6.597, lon: 106.799, tags: { amenity: "place_of_worship", religion: "muslim", name: "Masjid Dilindungi Palsu" } },
  { type: "node", id: 7, lat: -6.6, lon: 106.802, tags: { amenity: "place_of_worship", religion: "muslim", name: "Masjid Cara Lain Palsu" } },
] as const;

const DIPERIKSA = { sumber: "Google Maps", nama: "Masjid Dilindungi Palsu", aksesibilitas: ["Pintu masuk khusus pengguna kursi roda"], diambil: "2026-11-23", belum_diperiksa_tim: false };
const CARA_LAIN = { sumber: "Google Maps", nama: "Masjid Cara Lain Palsu", aksesibilitas: ["Toilet khusus pengguna kursi roda"], diambil: "2026-11-23", metode: "places-api", belum_diperiksa_tim: true };

const access = (group: string, entries: Record<string, boolean>) => ({ [group]: Object.entries(entries).map(([label, value]) => ({ [label]: value })) });
function item(placeId: string, title: string, lat: number, lng: number, categories: string[], extra: Record<string, unknown> = {}) {
  return { placeId, title, location: { lat, lng }, categoryName: categories[0], categories, scrapedAt: "2026-11-26T03:00:00.000Z", url: "https://www.google.com/maps/search/?api=1&query=palsu", ...extra };
}

const ITEMS = [
  // Dua hasil bernama sama di dekat dua masjid OSM bernama sama: masing-masing mendapat yang terdekat.
  item("palsu-1", "Masjid Uji Coba Al Palsu", -6.5705, 106.7647, ["Masjid"], { additionalInfo: { ...access("Aksesibilitas", { "Pintu masuk khusus pengguna kursi roda": true, "Toilet khusus pengguna kursi roda": false }), Layanan: [{ "Wi-Fi": true }] } }),
  item("palsu-2", "Masjid Uji Coba Al-Palsu", -6.5705, 106.765, ["Masjid"], { additionalInfo: access("Aksesibilitas", { "Tempat parkir khusus pengguna kursi roda": true }) }),
  // Hanya dekat masjid 1, yang sudah diambil palsu-1 yang lebih dekat.
  item("palsu-3", "Masjid Uji Coba Al Palsu", -6.5705, 106.7636, ["Masjid"], { additionalInfo: access("Aksesibilitas", { "Pintu masuk khusus pengguna kursi roda": false }) }),
  item("palsu-4", "Rumah Sakit Contoh Palsu", -6.5959, 106.7944, ["Rumah Sakit Umum", "Rumah Sakit"], { additionalInfo: access("Aksesibilitas", { "Tempat duduk khusus pengguna kursi roda": true, "Alat bantu dengar": true }) }),
  item("palsu-5", "Klinik Contoh Palsu", -6.5959, 106.7943, ["Klinik"], { additionalInfo: access("Aksesibilitas", { "Pintu masuk khusus pengguna kursi roda": true }) }),
  item("palsu-6", "Rumah Sakit Hewan Contoh Palsu", -6.596, 106.7943, ["Rumah sakit hewan"]),
  item("palsu-7", "Halte Uji Coba Palsu", -6.5958, 106.8015, ["Halte bus"], { additionalInfo: access("Aksesibilitas", { "Pintu masuk khusus pengguna kursi roda": true }) }),
  item("palsu-8", "Masjid Lain Sekali", -6.5706, 106.7645, ["Masjid"], { additionalInfo: access("Aksesibilitas", { "Pintu masuk khusus pengguna kursi roda": true }) }),
  item("palsu-9", "Masjid Dilindungi Palsu", -6.5971, 106.799, ["Masjid"], { additionalInfo: access("Aksesibilitas", { "Toilet khusus pengguna kursi roda": true }) }),
  item("palsu-10", "Masjid Cara Lain Palsu", -6.6001, 106.802, ["Masjid"], { additionalInfo: access("Aksesibilitas", { "Toilet khusus pengguna kursi roda": false }) }),
  item("palsu-11", "Halte Uji Coba Palsu", -6.5959, 106.7961, ["Halte Bus"]),
  item("palsu-12", "Universitas Palsu", -6.5901, 106.8, ["Universitas Swasta"], { additionalInfo: access("Accessibility", { "Wheelchair accessible seating": true }) }),
  // Salinan lebih lama dari palsu-1, tempat tutup permanen, dan hasil tanpa titik.
  item("palsu-1", "Masjid Uji Coba Al Palsu (lama)", -6.5705, 106.7647, ["Masjid"], { scrapedAt: "2026-11-20T00:00:00.000Z" }),
  item("palsu-13", "Masjid Uji Coba Al Palsu", -6.5705, 106.7646, ["Masjid"], { permanentlyClosed: true }),
  { placeId: "palsu-14", title: "Tanpa Titik Palsu", categories: ["Masjid"] },
];

describe("Google Maps results from Apify", () => {
  it("keeps one place per placeId, only the accessibility group, and skips closed or incomplete results", () => {
    const { places, skipped } = parseApifyItems(ITEMS);
    expect(skipped).toEqual({ incomplete: 1, closed: 1, duplicates: 1 });
    expect(places).toHaveLength(12);
    const first = places.find((p) => p.placeId === "palsu-1")!;
    expect(first).toMatchObject({ name: "Masjid Uji Coba Al Palsu", available: ["Pintu masuk khusus pengguna kursi roda"], unavailable: ["Toilet khusus pengguna kursi roda"] });
    expect(first.retrievedAt.toISOString()).toBe("2026-11-26T03:00:00.000Z");
    expect(places.find((p) => p.placeId === "palsu-12")!.available).toEqual(["Wheelchair accessible seating"]);
  });

  it("uses the run's finish time when a result has no scrapedAt", () => {
    const { places } = parseApifyItems([{ ...ITEMS[0], scrapedAt: undefined }], new Date("2026-11-26T05:00:00Z"));
    expect(places[0]!.retrievedAt.toISOString()).toBe("2026-11-26T05:00:00.000Z");
    expect(parseApifyItems([{ ...ITEMS[0], scrapedAt: undefined }]).skipped.incomplete).toBe(1);
  });

  it("maps Indonesian and English Google categories to ours, never animal hospitals", () => {
    expect([...googleCategories(["Rumah Sakit Umum"])]).toEqual(["rumah_sakit"]);
    expect([...googleCategories(["Masjid"])]).toEqual(["masjid"]);
    expect([...googleCategories(["Halte Bus"])]).toEqual(["halte"]);
    expect([...googleCategories(["Perguruan Tinggi Swasta"])]).toEqual(["kampus"]);
    expect([...googleCategories(["Mosque"])]).toEqual(["masjid"]);
    expect(googleCategories(["Rumah sakit hewan"]).size).toBe(0);
    expect(googleCategories(["Klinik", "Apotek"]).size).toBe(0);
  });
});

describe("decide", () => {
  const value = { aksesibilitas: ["Pintu masuk khusus pengguna kursi roda"], tidak_tersedia: [], diambil: "2026-11-26T03:00:00.000Z", metode: IMPORT_METHOD, belum_diperiksa_tim: true } as unknown as TagValue;

  it("writes new and changed copies from this import only", () => {
    expect(decide(null, value)).toBe("baru");
    expect(decide({ ...value }, value)).toBe("sama");
    expect(decide(JSON.stringify({ ...value, tidak_tersedia: ["Toilet"] }), value)).toBe("diperbarui");
    expect(decide({ ...value, diambil: "2026-12-01T00:00:00.000Z" }, value)).toBe("lebih_baru");
    expect(decide(null, { ...value, aksesibilitas: [] })).toBe("tanpa_atribut");
  });

  it("never touches team-checked or unknown copies, and other methods only on request", () => {
    expect(decide(DIPERIKSA, value)).toBe("dilindungi");
    expect(decide({ ...value, belum_diperiksa_tim: undefined }, value)).toBe("dilindungi");
    expect(decide("ramp ada", value)).toBe("dilindungi");
    expect(decide(CARA_LAIN, value)).toBe("cara_lain");
    expect(decide(CARA_LAIN, value, { replaceOtherMethods: true })).toBe("diperbarui");
    expect(decide(DIPERIKSA, value, { replaceOtherMethods: true })).toBe("dilindungi");
  });
});

describe("importGoogleMaps", () => {
  let db: Db;
  let close: () => Promise<void>;
  const { places } = parseApifyItems(ITEMS);
  const tags = async () => {
    const result = await db.execute(sql`SELECT osm_type || '/' || osm_id AS ref, tags->${GOOGLE_MAPS_TAG} AS google FROM osm_places WHERE tags ? ${GOOGLE_MAPS_TAG} ORDER BY osm_id`);
    return Object.fromEntries((result as unknown as { rows: { ref: string; google: unknown }[] }).rows.map((r) => [r.ref, r.google]));
  };
  const counts = async () => {
    const result = await db.execute(sql`SELECT (SELECT count(*) FROM osm_places)::int AS osm, (SELECT count(*) FROM places)::int AS places`);
    return (result as unknown as { rows: { osm: number; places: number }[] }).rows[0]!;
  };

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await seedSampleData(db);
    await loadFacilities(db, parseFacilities({ elements: [...OSM] }), { url: "https://overpass.example/palsu", retrievedAt: new Date("2026-11-20T00:00:00Z"), sha256: "b".repeat(64) });
    for (const [id, copy] of [[6, DIPERIKSA], [7, CARA_LAIN]] as const) {
      await db.execute(sql`UPDATE osm_places SET tags = tags || jsonb_build_object(${GOOGLE_MAPS_TAG}::text, ${JSON.stringify(copy)}::jsonb) WHERE osm_type = 'node' AND osm_id = ${id}`);
    }
  }, 60_000);

  afterAll(async () => {
    await close();
  });

  it("reports matches and reasons in a dry run without writing anything", async () => {
    const before = { tags: await tags(), counts: await counts() };
    expect(before.counts.osm).toBe(7);
    const report = await importGoogleMaps(db, places, { dryRun: true });
    expect(report.written).toBe(0);
    expect(Object.fromEntries(report.matches.map((m) => [m.place.placeId, `${m.osm.osmType}/${m.osm.osmId} ${m.decision}`]))).toEqual({
      "palsu-1": "node/1 baru",
      "palsu-2": "node/2 baru",
      "palsu-4": "node/3 baru",
      "palsu-11": "node/4 tanpa_atribut",
      "palsu-12": "node/5 baru",
      "palsu-9": "node/6 dilindungi",
      "palsu-10": "node/7 cara_lain",
    });
    expect(Object.fromEntries(report.unmatched.map((u) => [u.place.placeId, u.reason]))).toEqual({
      "palsu-3": "ambigu",
      "palsu-5": "kategori",
      "palsu-6": "kategori",
      "palsu-7": "jarak",
      "palsu-8": "nama",
    });
    const summary = summarize(report);
    expect(summary.decisions).toMatchObject({ baru: 4, tanpa_atribut: 1, dilindungi: 1, cara_lain: 1 });
    expect(summary.reasons).toEqual({ kategori: 2, jarak: 1, nama: 1, ambigu: 1 });
    expect(summary.categories.get("masjid")).toMatchObject({ cocok: 4, denganAtribut: 4, flags: { entrance: { ada: 1, tidak: 0 }, restroom: { ada: 1, tidak: 2 }, parking: { ada: 1, tidak: 0 } } });
    expect(summary.categories.get("rumah_sakit")).toMatchObject({ cocok: 1, denganAtribut: 1, flags: { seating: { ada: 1, tidak: 0 } }, lain: 1 });
    expect({ tags: await tags(), counts: await counts() }).toEqual(before);
  });

  it("writes only new copies that the hints route can read, without adding places", async () => {
    const before = await counts();
    const report = await importGoogleMaps(db, places, { dryRun: false });
    expect(report.written).toBe(4);
    expect(await counts()).toEqual(before);
    const stored = await tags();
    expect(stored["node/1"]).toEqual({
      sumber: "Google Maps",
      nama: "Masjid Uji Coba Al Palsu",
      url: "https://www.google.com/maps/search/?api=1&query=Masjid%20Uji%20Coba%20Al%20Palsu&query_place_id=palsu-1",
      place_id: "palsu-1",
      aksesibilitas: ["Pintu masuk khusus pengguna kursi roda"],
      tidak_tersedia: ["Toilet khusus pengguna kursi roda"],
      diambil: "2026-11-26T03:00:00.000Z",
      metode: IMPORT_METHOD,
      jarak_titik_m: 22,
      belum_diperiksa_tim: true,
    });
    expect(storedGoogle(stored["node/1"])).toMatchObject({ result: "stored", placeName: "Masjid Uji Coba Al Palsu", distanceMeters: 22, retrievedAt: "2026-11-26", accessibility: { entrance: true, restroom: false, parking: null, seating: null } });
    expect(storedGoogle(stored["node/5"])?.accessibility.seating).toBe(true);
    expect(stored["node/4"]).toBeUndefined();
    expect(stored["node/6"]).toEqual(DIPERIKSA);
    expect(stored["node/7"]).toEqual(CARA_LAIN);
  });

  it("is idempotent, keeps newer copies, and replaces other methods only on request", async () => {
    const again = await importGoogleMaps(db, places, { dryRun: false });
    expect(again.written).toBe(0);
    expect(summarize(again).decisions).toMatchObject({ sama: 4, baru: 0 });

    const older = parseApifyItems(ITEMS.map((i) => ({ ...i, scrapedAt: "2026-11-01T00:00:00.000Z" }))).places;
    expect(summarize(await importGoogleMaps(db, older, { dryRun: false })).decisions).toMatchObject({ lebih_baru: 4, baru: 0, diperbarui: 0 });

    const replaced = await importGoogleMaps(db, places, { dryRun: false, replaceOtherMethods: true });
    expect(replaced.written).toBe(1);
    const stored = await tags();
    expect(stored["node/7"]).toMatchObject({ metode: IMPORT_METHOD, tidak_tersedia: ["Toilet khusus pengguna kursi roda"] });
    expect(stored["node/6"]).toEqual(DIPERIKSA);
  });
});
