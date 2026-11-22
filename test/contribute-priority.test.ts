import { describe, expect, it } from "vitest";
import { levelOf, rankDistricts } from "../src/contribute/priority.js";

describe("rankDistricts", () => {
  it("multiplies the share of registered people by the share of places without data", () => {
    const ranked = rankDistricts([
      { slug: "a", name: "A", registered: 200, verifiedPlaces: 0, facilitiesWithoutData: 10 },
      { slug: "b", name: "B", registered: 200, verifiedPlaces: 10, facilitiesWithoutData: 10 },
      { slug: "c", name: "C", registered: 100, verifiedPlaces: 0, facilitiesWithoutData: 0 },
      { slug: "d", name: "D", registered: 0, verifiedPlaces: 1, facilitiesWithoutData: 5 },
    ]);
    expect(ranked.map((d) => [d.slug, d.score, d.rank, d.level])).toEqual([
      ["a", 100, 1, "sangat_tinggi"],
      ["b", 50, 2, "tinggi"],
      ["c", 50, 3, "tinggi"],
      ["d", 0, 4, "rendah"],
    ]);
  });

  it("puts the level thresholds at 25, 50 and 75", () => {
    expect([24, 25, 49, 50, 74, 75].map(levelOf)).toEqual(["rendah", "sedang", "sedang", "tinggi", "tinggi", "sangat_tinggi"]);
  });
});
