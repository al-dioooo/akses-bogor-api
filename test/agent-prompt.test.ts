import { describe, expect, it } from "vitest";
import { ROUTE_CLAIM_NOTE, guardRouteClaims, systemPrompt } from "../src/agent/prompt.js";

describe("guardRouteClaims", () => {
  it("keeps negated route sentences and the place's own status", () => {
    for (const text of [
      "Rute ini belum tentu aksesibel. Lihat peringatan di layar.",
      "Saya tidak bisa memastikan jalur ke sana ramah kursi roda.",
      "Halte ini berstatus aksesibel menurut data terverifikasi AksesBogor.",
      "Masjid di Jalan Pajajaran ini aksesibel sebagian.",
    ]) {
      expect(guardRouteClaims(text)).toBe(text);
    }
  });

  it("drops positive route claims and adds the fixed note", () => {
    expect(guardRouteClaims("Jalur menuju pintu masuk bebas hambatan.")).toBe(ROUTE_CLAIM_NOTE);
    expect(guardRouteClaims("Ada lift. Perjalanan ke sana mudah dilalui kursi roda!")).toBe(`Ada lift.\n\n${ROUTE_CLAIM_NOTE}`);
  });

});

describe("systemPrompt", () => {
  it("writes the verification date as a WIB calendar date", () => {
    expect(systemPrompt({ id: "x", name: "Tempat", lastVerifiedAt: "2026-10-17T18:00:00.000Z" })).toContain('"lastVerifiedAt":"2026-10-18"');
  });
});
