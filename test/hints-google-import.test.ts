import { describe, expect, it } from "vitest";
import { decide, googleCategories, IMPORT_METHOD, parseApifyItems, type TagValue } from "../src/hints/google-maps-import.js";

// Semua tempat dan hasil Google di sini palsu, hanya untuk tes, dan tidak pernah dimuat sebagai data.
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
