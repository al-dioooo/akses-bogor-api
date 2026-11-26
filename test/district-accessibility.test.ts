import { describe, expect, it } from "vitest";
import { MINIMUM_PLACES, entranceOf, osmEntrance, rankAccessibility } from "../src/hints/districts.js";

const google = (entrance: boolean, diambil: string) => ({
  nama: "Tempat di Google",
  place_id: "ChIJcontoh",
  aksesibilitas: entrance ? ["wheelchairAccessibleEntrance"] : [],
  tidak_tersedia: entrance ? [] : ["wheelchairAccessibleEntrance"],
  diambil,
});

describe("entrance sources", () => {
  it("reads the OSM wheelchair values and ignores the rest", () => {
    expect(["yes", "designated", "limited", "no", "unknown", null].map(osmEntrance)).toEqual(["bisa", "bisa", "terbatas", "tidak", null, null]);
  });

  it("takes the AksesBogor ramp answer, with Tidak perlu as a level entrance", () => {
    expect(entranceOf({ kind: "aksesbogor", ramp: "tidak_perlu" }, true)).toEqual({ entrance: "bisa", source: "aksesbogor" });
    expect(entranceOf({ kind: "aksesbogor", ramp: "tidak_tersedia" }, true)).toEqual({ entrance: "tidak", source: "aksesbogor" });
    expect(entranceOf({ kind: "aksesbogor", ramp: "belum_tahu" }, true)).toBeNull();
  });

  it("prefers the place's own OSM tag, then the stored OSM note, then the stored Google copy, and reads copies only when stored hints are on", () => {
    const copy = google(false, "2026-11-22T20:15:00Z");
    expect(entranceOf({ kind: "osm", wheelchair: "yes", google: copy, osmNote: { wheelchair: "no" } }, true)).toEqual({ entrance: "bisa", source: "openstreetmap" });
    expect(entranceOf({ kind: "osm", wheelchair: null, google: copy, osmNote: { wheelchair: "limited" } }, true)).toEqual({ entrance: "terbatas", source: "openstreetmap" });
    expect(entranceOf({ kind: "osm", wheelchair: null, google: copy, osmNote: null }, true)).toEqual({ entrance: "tidak", source: "google_maps", retrievedAt: "2026-11-23" });
    expect(entranceOf({ kind: "osm", wheelchair: null, google: copy, osmNote: { wheelchair: "yes" } }, false)).toBeNull();
    // Salinan Google tanpa keterangan pintu masuk tidak dihitung.
    expect(entranceOf({ kind: "osm", wheelchair: null, google: { ...copy, tidak_tersedia: ["wheelchairAccessibleRestroom"] }, osmNote: null }, true)).toBeNull();
  });

  it("ranks by score, then by places with data, then by name, and leaves kecamatan with too little data unranked", () => {
    const district = (name: string, withData: number, accessible: number) => ({
      slug: name.toLowerCase(),
      name,
      places: withData + 3,
      withData,
      accessible,
      limited: 0,
      notAccessible: withData - accessible,
      bySource: { aksesbogor: { withData: 0, accessible: 0 }, openstreetmap: { withData, accessible }, google_maps: { withData: 0, accessible: 0 } },
    });
    const ranked = rankAccessibility([district("C", 10, 5), district("A", 4, 4), district("B", 6, 3), district("D", 5, 4)]);
    expect(ranked.map((d) => [d.name, d.score, d.rank])).toEqual([
      ["D", 80, 1],
      ["C", 50, 2],
      ["B", 50, 3],
      ["A", null, null],
    ]);
    expect(MINIMUM_PLACES).toBe(5);
  });
});
