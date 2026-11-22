import { describe, expect, it } from "vitest";
import { SYNONYM_GROUPS } from "../src/knowledge/sinonim.js";
import { stem } from "../src/knowledge/stemmer.js";

describe("SYNONYM_GROUPS", () => {
  it("holds groups of at least two lowercase phrases made of letters and spaces", () => {
    for (const group of SYNONYM_GROUPS) {
      expect(group.length).toBeGreaterThanOrEqual(2);
      for (const phrase of group) expect(phrase).toMatch(/^[a-z]+( [a-z]+)*$/);
    }
  });

  it("puts each phrase, compared by stem, in one group only", () => {
    const seen = new Map<string, number>();
    SYNONYM_GROUPS.forEach((group, index) => {
      for (const phrase of group) {
        const key = phrase.split(" ").map(stem).join(" ");
        expect(seen.get(key) ?? index, `"${phrase}" ada di dua kelompok`).toBe(index);
        seen.set(key, index);
      }
    });
  });
});
