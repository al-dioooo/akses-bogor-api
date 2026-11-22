import { describe, expect, it } from "vitest";
import { classify, keptTags, parseOverpass, routePassage, routeTitle } from "../src/knowledge/osm.js";
import { elements } from "./helpers/overpass.js";

describe("OpenStreetMap parsing", () => {
  it("classifies features with the most decisive tag first", () => {
    expect(classify({ highway: "steps", ramp: "yes" })).toBe("tangga");
    expect(classify({ highway: "elevator" })).toBe("lift");
    expect(classify({ entrance: "main", wheelchair: "yes" })).toBe("pintu_masuk");
    expect(classify({ highway: "crossing", kerb: "lowered", tactile_paving: "yes" })).toBe("kerb");
    expect(classify({ tactile_paving: "yes" })).toBe("guiding_block");
    expect(classify({ highway: "bus_stop", wheelchair: "yes" })).toBe("halte");
    expect(classify({ amenity: "toilets", "toilets:wheelchair": "no" })).toBe("tempat");
    expect(classify({ elevator: "no", amenity: "cafe" })).toBeNull();
  });

  it("keeps only allow-listed tags, so contact details are dropped", () => {
    expect(keptTags({ name: "Halte", phone: "+62", website: "https://x", "contact:email": "a@b.c", wheelchair: "yes" })).toEqual({ name: "Halte", wheelchair: "yes" });
  });

  it("turns nodes, ways and relations into points and lines", () => {
    const { features } = parseOverpass({ elements });
    const byId = new Map(features.map((f) => [`${f.osmType}/${f.osmId}`, f]));
    expect(byId.get("node/1")).toMatchObject({ kind: "halte", name: "Halte Kebun Raya", geometry: { type: "Point", coordinates: [106.795, -6.595] } });
    expect(byId.get("node/1")!.tags).toEqual({ highway: "bus_stop", name: "Halte Kebun Raya" });
    expect(byId.get("way/10")).toMatchObject({ kind: "tangga", geometry: { type: "LineString" } });
    expect(byId.get("relation/20")).toMatchObject({ kind: "tempat", geometry: { type: "Point", coordinates: [106.799, -6.597] } });
    // Jalan anggota rute tanpa tag aksesibilitas dan rute itu sendiri bukan fitur.
    expect(byId.has("way/50")).toBe(false);
    expect(byId.has("relation/100")).toBe(false);
  });

  it("reads bus routes with ordered stops, without repeating a stop and its platform", () => {
    const { routes } = parseOverpass({ elements });
    const route = routes.find((r) => r.osmId === 100)!;
    expect(route).toMatchObject({ ref: "02", network: "Angkutan Kota Bogor", fromName: "Sukasari", toName: "Bubulak" });
    expect(route.stops).toEqual([
      { osmType: "node", osmId: 1, name: "Halte Kebun Raya" },
      { osmType: "node", osmId: 2, name: "Halte Monas" },
    ]);
    expect(route.ways.map((w) => w.name)).toEqual(["Jalan Pajajaran", "Jalan Medan Merdeka"]);
  });

  it("writes a searchable passage for a route", () => {
    const route = { osmId: 100, ref: "02", name: "Sukasari–Bubulak", operator: null, network: "Angkutan Kota Bogor", fromName: "Sukasari", toName: "Bubulak", via: null };
    expect(routeTitle(route)).toBe("Angkutan Kota Bogor (angkot) 02: Sukasari–Bubulak");
    const passage = routePassage({ ...route, stops: [] }, ["Jalan Pajajaran"]);
    expect(passage.citation).toBe("OpenStreetMap, relasi rute 100");
    expect(passage.body).toBe(
      "Angkutan Kota Bogor (angkot) 02: Sukasari–Bubulak. Dari Sukasari ke Bubulak. Jalan yang dilewati di Kota Bogor: Jalan Pajajaran. OpenStreetMap tidak mencatat halte untuk rute ini.",
    );
  });
});
