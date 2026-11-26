import { describe, expect, it } from "vitest";
import { coverageOf, roughDistance } from "../src/map/accessible-route.js";
import { WAY, parseWayFlags } from "../src/map/accessible-ways.js";
import type { RouterEdge } from "../src/map/valhalla.js";

describe("coverageOf", () => {
  const ways = parseWayFlags(
    JSON.stringify({
      versi: 1,
      sumber: "java-latest.osm.pbf 2026-11-25",
      jalur: {
        1: WAY.sidewalkKnown | WAY.surfaceKnown,
        2: WAY.sidewalkKnown | WAY.crossing | WAY.kerbKnown | WAY.raisedKerb,
        3: WAY.sidewalkKnown | WAY.crossing,
        4: WAY.sidewalkKnown | WAY.noSidewalk | WAY.surfaceKnown | WAY.roughSurface,
        5: WAY.steep,
      },
    }),
  );
  const edges: RouterEdge[] = [
    { wayId: 1, lengthMeters: 400, use: "sidewalk" },
    { wayId: 2, lengthMeters: 15, use: "pedestrian_crossing" },
    { wayId: 3, lengthMeters: 15, use: "pedestrian_crossing" },
    { wayId: 4, lengthMeters: 120, use: "road" },
    { wayId: 5, lengthMeters: 50, use: "road" },
    { wayId: 9, lengthMeters: 400, use: "road" },
  ];

  it("measures how much of the route has sidewalk, surface and kerb data", () => {
    const { coverage, warnings } = coverageOf(edges, ways, "kursi_roda");
    expect(coverage).toEqual({ sidewalkPercent: 55, surfacePercent: 52, crossings: 2, crossingsWithKerb: 1, dataDate: "2026-11-25" });
    expect(warnings.map((w) => w.code)).toEqual([
      "kerb_tinggi",
      "tanpa_trotoar",
      "permukaan_buruk",
      "tanjakan_curam",
      "data_trotoar_kurang",
      "data_permukaan_kurang",
      "data_kerb_kurang",
      "kemiringan_tidak_dihitung",
    ]);
    expect(warnings.find((w) => w.code === "data_trotoar_kurang")!.message).toBe("Data trotoar belum tercatat di OpenStreetMap untuk 45% panjang rute.");
    expect(warnings.find((w) => w.code === "data_kerb_kurang")!.message).toBe("Kerb belum tercatat di 1 dari 2 penyeberangan pada rute ini.");
    expect(warnings.find((w) => w.code === "tanpa_trotoar")!.message).toBe("Sekitar 120 m rute berada di jalan yang tercatat tanpa trotoar.");
  });

  it("warns about steps on a walking route and leaves the slope note to the wheelchair profile", () => {
    const { warnings } = coverageOf([{ wayId: 1, lengthMeters: 400, use: "footway" }, { wayId: 7, lengthMeters: 18, use: "steps" }], ways, "jalan_kaki");
    expect(warnings[0]).toEqual({ code: "melewati_tangga", message: "Rute ini melewati tangga sekitar 20 m." });
    expect(warnings.map((w) => w.code)).not.toContain("kemiringan_tidak_dihitung");
  });

  it("says the coverage is unknown without the ways file or the matched ways", () => {
    for (const result of [coverageOf(edges, null, "kursi_roda"), coverageOf(null, ways, "kursi_roda")]) {
      expect(result.coverage).toEqual({ sidewalkPercent: null, surfacePercent: null, crossings: null, crossingsWithKerb: null, dataDate: null });
      expect(result.warnings.map((w) => w.code)).toEqual(["cakupan_tidak_diketahui", "kemiringan_tidak_dihitung"]);
    }
  });

  it("rounds lengths for the warnings", () => {
    expect([3, 124, 999, 1440].map(roughDistance)).toEqual(["sekitar 10 m", "sekitar 120 m", "sekitar 1 km", "sekitar 1,4 km"]);
  });
});
