import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { categoryOf, getOsmPlace, loadFacilities, parseFacilities, placesWithoutData } from "../src/contribute/facilities.js";
import type { Db } from "../src/db/client.js";
import { seedSampleData } from "../src/db/seed.js";
import type { OverpassElement } from "../src/knowledge/osm.js";
import { createTestDb } from "./helpers/db.js";

// Titik dekat lokasi contoh dari seed: "Halte contoh" di Bogor Tengah (106.7942, -6.5958) dan "Rumah sakit contoh" di
// Bogor Barat (106.764, -6.57).
const elements: OverpassElement[] = [
  // Halte 20 m dari "Halte contoh": sudah punya data AksesBogor.
  { type: "node", id: 1, lat: -6.5959, lon: 106.7943, tags: { highway: "bus_stop", name: "Halte Pajajaran", phone: "0251-1" } },
  // Masjid di Bogor Barat tanpa lokasi AksesBogor di dekatnya.
  { type: "way", id: 2, center: { lat: -6.5705, lon: 106.7645 }, tags: { amenity: "place_of_worship", religion: "muslim", name: "Masjid Al-Ikhlas" } },
  // Rumah sakit 60 m dari "Rumah sakit contoh": di luar jarak 50 m, jadi belum punya data.
  { type: "node", id: 3, lat: -6.5705, lon: 106.764, tags: { amenity: "hospital" } },
  // Gereja bukan kategori MVP.
  { type: "node", id: 4, lat: -6.5706, lon: 106.7646, tags: { amenity: "place_of_worship", religion: "christian", name: "Gereja" } },
  // Halte di Jakarta, di luar Kota Bogor.
  { type: "node", id: 5, lat: -6.2, lon: 106.82, tags: { highway: "bus_stop", name: "Halte Jakarta" } },
];

describe("categoryOf", () => {
  it("maps OSM tags to the four MVP categories only", () => {
    expect(categoryOf({ amenity: "university" })).toBe("kampus");
    expect(categoryOf({ amenity: "college" })).toBe("kampus");
    expect(categoryOf({ amenity: "place_of_worship", religion: "muslim" })).toBe("masjid");
    expect(categoryOf({ public_transport: "platform", bus: "yes" })).toBe("halte");
    expect(categoryOf({ amenity: "hospital" })).toBe("rumah_sakit");
    expect(categoryOf({ shop: "mall" })).toBeNull();
    expect(categoryOf({ amenity: "place_of_worship", religion: "christian" })).toBeNull();
  });
});

describe("facilities from OpenStreetMap", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await seedSampleData(db);
    const rows = parseFacilities({ elements });
    expect(rows.map((r) => r.osmId)).toEqual([1, 2, 3, 5]);
    expect(rows[0]!.tags).toEqual({ highway: "bus_stop", name: "Halte Pajajaran" });
    expect(await loadFacilities(db, rows, { url: "https://overpass-api.de/api/interpreter", retrievedAt: new Date("2026-11-22T10:00:00.000Z"), sha256: "e".repeat(64) })).toBe(3);
  }, 60_000);

  afterAll(async () => {
    await close();
  });

  it("lists places without AksesBogor data, without coordinates, in the given kecamatan order", async () => {
    const places = await placesWithoutData(db, { limit: 10, districtOrder: ["bogor-barat"] });
    expect(places).toEqual([
      { osm: { osmType: "way", osmId: 2 }, name: "Masjid Al-Ikhlas", category: "masjid", district: { slug: "bogor-barat", name: "Bogor Barat" } },
      { osm: { osmType: "node", osmId: 3 }, name: null, category: "rumah_sakit", district: { slug: "bogor-barat", name: "Bogor Barat" } },
    ]);
  });

  it("filters by kecamatan and category", async () => {
    expect(await placesWithoutData(db, { limit: 10, category: "rumah_sakit" })).toHaveLength(1);
    expect(await placesWithoutData(db, { limit: 10, district: "bogor-tengah" })).toEqual([]);
  });

  it("returns one place with its location for the web cards", async () => {
    expect(await getOsmPlace(db, { osmType: "node", osmId: 1 })).toMatchObject({ name: "Halte Pajajaran", hasAksesBogorData: true, district: { slug: "bogor-tengah" } });
    expect(await getOsmPlace(db, { osmType: "way", osmId: 2 })).toMatchObject({
      hasAksesBogorData: false,
      location: { lat: -6.5705, lng: 106.7645 },
      osmUrl: "https://www.openstreetmap.org/way/2",
    });
    expect(await getOsmPlace(db, { osmType: "node", osmId: 5 })).toBeNull();
  });
});
