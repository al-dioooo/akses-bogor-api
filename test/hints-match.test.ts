import { describe, expect, it } from "vitest";
import { categoryFits, distanceMeters, distinctiveWords, markers, nameScore, pickMatch, typeFits } from "../src/hints/match.js";

const SILOAM = { lat: -6.59567, lng: 106.80465 };
// About 0.0001° of latitude is 11 m.
const north = (point: { lat: number; lng: number }, meters: number) => ({ lat: point.lat + meters / 111_320, lng: point.lng });
// Category ids as Mapbox Search Box returned them for these places on 2026-11-23.
const HOSPITAL = ["health_services", "hospital", "hospital_unit", "services"];
const BUS_STOP = ["bus_stop", "transportation"];
const MOSQUE = ["mosque", "place_of_worship"];

describe("name matching", () => {
  it("drops place types, the city, and Arabic articles, maps common abbreviations, and keeps digits and single letters apart", () => {
    expect([...distinctiveWords("RS Siloam Hospitals Bogor")]).toEqual(["siloam"]);
    expect([...distinctiveWords("Masjid Al-Ikhlas")]).toEqual(["ikhlas"]);
    expect([...distinctiveWords("Halte Bus Pajajaran")]).toEqual(["pajajaran"]);
    expect([...distinctiveWords("Masjid Raya Bogor")]).toEqual(["raya"]);
    expect([...distinctiveWords("Puskesmas X 1")]).toEqual(["puskesmas"]);
    expect([...markers("Puskesmas X 1")]).toEqual(["x", "1"]);
  });

  it("scores shared distinctive words against the longer name", () => {
    expect(nameScore("Rumah Sakit Siloam Bogor", "Siloam Hospitals Bogor")).toBe(1);
    expect(nameScore("Universitas Pakuan", "Pakuan University Bogor")).toBe(1);
    expect(nameScore("Masjid Al-Ikhlas", "Masjid Al-Hidayah")).toBe(0);
    expect(nameScore("Halte", "Halte Bus")).toBe(0);
    // One shared word is no longer enough when the other name has more.
    expect(nameScore("Masjid Raya Bogor", "Masjid Raya Al-Mi'raj")).toBeCloseTo(1 / 3);
  });

  it("rejects a provider name with a place type that is neither ours nor in our name", () => {
    expect(typeFits("halte", "Halte Pajajaran", "RS Pajajaran")).toBe(false);
    expect(typeFits("halte", "Halte Baranangsiang", "Terminal Baranangsiang")).toBe(false);
    expect(typeFits("halte", "Terminal Baranangsiang", "Terminal Baranangsiang")).toBe(true);
    expect(typeFits("kampus", "Institut Pertanian Bogor", "ATM - Institut Pertanian Bogor")).toBe(false);
    expect(typeFits("masjid", "Masjid Taman Yasmin", "Masjid Raya Taman Yasmin")).toBe(true);
  });

  it("accepts only provider categories that fit our category", () => {
    expect(categoryFits("rumah_sakit", HOSPITAL)).toBe(true);
    expect(categoryFits("halte", HOSPITAL)).toBe(false);
    expect(categoryFits("halte", BUS_STOP)).toBe(true);
    expect(categoryFits("masjid", ["hospital"])).toBe(false);
    expect(categoryFits("kampus", ["atm", "bank"])).toBe(false);
    expect(categoryFits("rumah_sakit", [])).toBe(false);
  });

  it("measures distance in meters", () => {
    expect(Math.round(distanceMeters(SILOAM, north(SILOAM, 50)))).toBe(50);
  });
});

describe("pickMatch", () => {
  const target = { name: "RS Siloam Bogor", location: SILOAM, category: "rumah_sakit" as const };

  it("accepts a similar name within 75 m and prefers the closer of two equal names", () => {
    const match = pickMatch(target, [
      { name: "Siloam Hospitals Bogor", location: north(SILOAM, 60), categories: HOSPITAL, id: "jauh" },
      { name: "Siloam Hospitals Bogor", location: north(SILOAM, 10), categories: HOSPITAL, id: "dekat" },
    ]);
    expect(match).toMatchObject({ id: "dekat", distanceMeters: 10 });
  });

  it("rejects places further than 75 m, with another name or category, and unnamed targets", () => {
    expect(pickMatch(target, [{ name: "Siloam Hospitals Bogor", location: north(SILOAM, 90), categories: HOSPITAL }])).toBeNull();
    expect(pickMatch(target, [{ name: "Pool Taxol Siloam", location: SILOAM, categories: ["parking_lot", "transportation"] }])).toBeNull();
    expect(pickMatch(target, [{ name: "Siloam Hospitals Bogor", location: SILOAM, categories: [] }])).toBeNull();
    expect(pickMatch({ ...target, name: null }, [{ name: "Halte", location: SILOAM, categories: BUS_STOP }])).toBeNull();
  });

  it("never puts a hospital's or a terminal's hint on a bus stop of the same name", () => {
    const halte = { name: "Halte Pajajaran", location: SILOAM, category: "halte" as const };
    expect(pickMatch(halte, [{ name: "RS Pajajaran", location: north(SILOAM, 20), categories: HOSPITAL }])).toBeNull();
    // Mapbox files Terminal Baranangsiang under bus_stop, so the type word in the name has to reject it.
    const baranangsiang = { name: "Halte Baranangsiang", location: SILOAM, category: "halte" as const };
    expect(pickMatch(baranangsiang, [{ name: "Terminal Baranangsiang", location: north(SILOAM, 20), categories: BUS_STOP }])).toBeNull();
    expect(pickMatch(baranangsiang, [{ name: "Halte Baranangsiang", location: north(SILOAM, 20), categories: BUS_STOP }])).not.toBeNull();
  });

  it("rejects places whose numbers or single letters differ", () => {
    const puskesmas = { name: "Puskesmas X 1", location: SILOAM, category: "rumah_sakit" as const };
    expect(pickMatch(puskesmas, [{ name: "Puskesmas X 2", location: north(SILOAM, 5), categories: HOSPITAL }])).toBeNull();
    expect(pickMatch(puskesmas, [{ name: "Puskesmas Y 1", location: north(SILOAM, 5), categories: HOSPITAL }])).toBeNull();
    expect(pickMatch(puskesmas, [{ name: "Puskesmas X 1", location: north(SILOAM, 5), categories: HOSPITAL }])).not.toBeNull();
    const masjid = { name: "Masjid Al-Ikhlas", location: SILOAM, category: "masjid" as const };
    expect(pickMatch(masjid, [{ name: "Masjid Al-Ikhlas 2", location: north(SILOAM, 5), categories: MOSQUE }])).toBeNull();
  });

  it("rejects a provider place that shares only one of several distinctive words", () => {
    const masjid = { name: "Masjid Raya Bogor", location: SILOAM, category: "masjid" as const };
    expect(pickMatch(masjid, [{ name: "Masjid Raya Al-Mi'raj", location: north(SILOAM, 30), categories: MOSQUE }])).toBeNull();
  });
});
