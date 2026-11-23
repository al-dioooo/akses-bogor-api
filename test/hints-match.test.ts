import { describe, expect, it } from "vitest";
import { distanceMeters, distinctiveWords, nameScore, pickMatch } from "../src/hints/match.js";

const SILOAM = { lat: -6.59567, lng: 106.80465 };
// About 0.0001° of latitude is 11 m.
const north = (point: { lat: number; lng: number }, meters: number) => ({ lat: point.lat + meters / 111_320, lng: point.lng });

describe("name matching", () => {
  it("drops place types, the city, and Arabic articles, and maps common abbreviations", () => {
    expect([...distinctiveWords("RS Siloam Hospitals Bogor")]).toEqual(["siloam"]);
    expect([...distinctiveWords("Masjid Al-Ikhlas")]).toEqual(["ikhlas"]);
    expect([...distinctiveWords("Halte Bus Pajajaran")]).toEqual(["pajajaran"]);
    expect([...distinctiveWords("Masjid Raya Bogor")]).toEqual(["raya"]);
  });

  it("scores shared distinctive words against the shorter name", () => {
    expect(nameScore("Rumah Sakit Siloam Bogor", "Siloam Hospitals Bogor")).toBe(1);
    expect(nameScore("Masjid Al-Ikhlas", "Masjid Al-Hidayah")).toBe(0);
    expect(nameScore("Universitas Pakuan", "Pakuan University Bogor")).toBe(1);
    expect(nameScore("Halte", "Halte Bus")).toBe(0);
  });

  it("measures distance in meters", () => {
    expect(Math.round(distanceMeters(SILOAM, north(SILOAM, 50)))).toBe(50);
  });
});

describe("pickMatch", () => {
  const target = { name: "RS Siloam Bogor", location: SILOAM };

  it("accepts a similar name within 75 m and prefers the closer of two equal names", () => {
    const match = pickMatch(target, [
      { name: "Siloam Hospitals Bogor", location: north(SILOAM, 60), id: "jauh" },
      { name: "Siloam Hospitals Bogor", location: north(SILOAM, 10), id: "dekat" },
    ]);
    expect(match).toMatchObject({ id: "dekat", distanceMeters: 10 });
  });

  it("rejects places further than 75 m or with another name, and unnamed targets", () => {
    expect(pickMatch(target, [{ name: "Siloam Hospitals Bogor", location: north(SILOAM, 90) }])).toBeNull();
    expect(pickMatch(target, [{ name: "Pool Taxol", location: SILOAM }])).toBeNull();
    expect(pickMatch({ name: null, location: SILOAM }, [{ name: "Halte", location: SILOAM }])).toBeNull();
  });
});
