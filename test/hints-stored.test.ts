import { describe, expect, it } from "vitest";
import { optionKey, storedGoogle, storedOsm, withStored } from "../src/hints/stored.js";

const GOOGLE = {
  sumber: "Google Maps",
  nama: "Masjid Al-Ikhlas Bogor",
  url: "https://www.google.com/maps/place/?q=place_id:ChIJikhlas",
  place_id: "ChIJikhlas",
  aksesibilitas: ["wheelchairAccessibleEntrance", "wheelchairAccessibleParking"],
  tidak_tersedia: ["wheelchairAccessibleRestroom"],
  diambil: "2026-11-22T20:15:00Z",
  metode: "places-api",
  jarak_titik_m: 18.4,
};

describe("stored Google Maps copy", () => {
  it("keeps only the flags, name, distance, link and the WIB date it was taken", () => {
    expect(storedGoogle(GOOGLE)).toEqual({
      provider: "google",
      result: "stored",
      placeName: "Masjid Al-Ikhlas Bogor",
      distanceMeters: 18,
      url: "https://www.google.com/maps/place/?q=place_id:ChIJikhlas",
      retrievedAt: "2026-11-23",
      accessibility: { entrance: true, restroom: false, parking: true, seating: null },
    });
  });

  it("reads a copy stored as a JSON string and Indonesian option labels", () => {
    const copy = storedGoogle(JSON.stringify({ ...GOOGLE, aksesibilitas: ["Tempat duduk ramah kursi roda"], tidak_tersedia: undefined, jarak_titik_m: undefined }));
    expect(copy?.accessibility).toEqual({ entrance: null, restroom: null, parking: null, seating: true });
    expect(copy?.distanceMeters).toBeNull();
  });

  it("drops copies already checked, e.g. from Street View evidence (ADR-0057)", () => {
    expect(storedGoogle({ ...GOOGLE, belum_diperiksa_tim: false })).toBeNull();
    expect(storedGoogle({ ...GOOGLE, belum_diperiksa_tim: true })).not.toBeNull();
    expect(storedOsm({ wheelchair: "yes", belum_diperiksa_tim: false }, null)).toBeNull();
    expect(storedOsm({ wheelchair: "yes" }, null)).toEqual({ provider: "openstreetmap", result: "stored", wheelchair: "yes" });
  });

  it("drops a copy without a date or without any flag, and links that are not Google Maps over https", () => {
    expect(storedGoogle({ ...GOOGLE, diambil: "kemarin" })).toBeNull();
    expect(storedGoogle({ ...GOOGLE, aksesibilitas: [], tidak_tersedia: [] })).toBeNull();
    expect(storedGoogle("ramp ada")).toBeNull();
    expect(storedGoogle({ ...GOOGLE, url: "javascript:alert(1)" })?.url).toBeNull();
    expect(storedGoogle({ ...GOOGLE, url: "https://maps.google.com.evil.example/x" })?.url).toBeNull();
    expect(storedGoogle({ ...GOOGLE, url: "https://maps.app.goo.gl/abc" })?.url).toBe("https://maps.app.goo.gl/abc");
  });

  it("maps option names to the four flags", () => {
    expect(["Pintu masuk ramah kursi roda", "Toilet ramah kursi roda", "Tempat parkir ramah kursi roda", "wheelchairAccessibleSeating", "ramp"].map(optionKey)).toEqual([
      "entrance",
      "restroom",
      "parking",
      "seating",
      null,
    ]);
  });
});

describe("stored OpenStreetMap note", () => {
  it("is kept only for a known value that differs from the place's own wheelchair tag", () => {
    expect(storedOsm({ wheelchair: "limited", arti: "sebagian" }, null)).toEqual({ provider: "openstreetmap", result: "stored", wheelchair: "limited" });
    expect(storedOsm({ wheelchair: "limited" }, "limited")).toBeNull();
    expect(storedOsm({ wheelchair: "mungkin" }, null)).toBeNull();
    expect(storedOsm(null, null)).toBeNull();
  });
});

describe("live and stored hints together", () => {
  const stored = [storedGoogle(GOOGLE)!, storedOsm({ wheelchair: "yes" }, null)!];
  it("uses the stored Google copy unless Google found the place live", () => {
    expect(withStored([{ provider: "google", result: "none" }], stored).map((h) => `${h.provider}:${h.result}`)).toEqual(["google:none", "google:stored", "openstreetmap:stored"]);
    const live = { provider: "google" as const, result: "found" as const, placeName: "x", distanceMeters: 3, url: null, accessibility: { entrance: true, restroom: null, parking: null, seating: null } };
    expect(withStored([live], stored).map((h) => `${h.provider}:${h.result}`)).toEqual(["google:found", "openstreetmap:stored"]);
  });
});
