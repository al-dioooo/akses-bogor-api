import { describe, expect, it } from "vitest";
import { ASSISTANT_PROFILE, PLACE_CLAIM_NOTE, assistantPrompt, guardAssistantAnswer, guardPlaceClaims, plainTerms } from "../src/agent/assistant-prompt.js";
import { ROUTE_CLAIM_NOTE } from "../src/agent/prompt.js";
import type { Db } from "../src/db/client.js";

const ctx = (position?: { lat: number; lng: number }) => ({ db: {} as Db, now: () => new Date(), position });
const unchecked = { checkedPlace: false };
const checked = { checkedPlace: true };

describe("assistantPrompt", () => {
  it("tells the model whether a start point exists but never its value", () => {
    expect(assistantPrompt(undefined, ctx())).toContain("Titik awal pengunjung: belum dipilih.");
    const withStart = assistantPrompt(undefined, ctx({ lat: -6.59585, lng: 106.79425 }));
    expect(withStart).toContain("Titik awal pengunjung: sudah dipilih");
    expect(withStart).not.toMatch(/-6\.\d|106\.\d/);
  });

  it("adds the chosen place with its date in WIB", () => {
    const place = { id: "p1", name: "Halte contoh", lastVerifiedAt: "2026-10-17T20:00:00.000Z", checkedByTeam: true };
    const prompt = assistantPrompt(place, ctx());
    expect(prompt).toContain('"name":"Halte contoh"');
    expect(prompt).toContain('"lastVerifiedAt":"2026-10-18"');
  });

  it("states the honesty rules", () => {
    const prompt = assistantPrompt();
    expect(prompt).toContain("panggil show_route");
    expect(prompt).toContain("Jangan pernah menyebut rute");
    expect(prompt).toContain("checkedByTeam benar");
    expect(prompt).toContain("belum diperiksa tim");
    expect(prompt).toContain("Jangan memberi saran medis");
    expect(prompt).toContain("juga bila titik awal belum dipilih");
    expect(prompt).toContain("jangan menyebut nomor telepon dari ingatan");
  });

  it("is the prompt of the assistant profile", () => {
    expect(ASSISTANT_PROFILE.system()).toBe(assistantPrompt());
  });
});

describe("guardPlaceClaims", () => {
  it("drops an accessibility claim when no team-checked place was read", () => {
    const answer = guardPlaceClaims("Halte Baranangsiang ramah kursi roda. Halte itu dekat terminal.", unchecked);
    expect(answer).toBe(`Halte itu dekat terminal.\n\n${PLACE_CLAIM_NOTE}`);
  });

  it("keeps negated claims and claims backed by team-checked data", () => {
    const negated = "Belum diketahui apakah halte itu aksesibel.";
    expect(guardPlaceClaims(negated, unchecked)).toBe(negated);
    const backed = "Masjid contoh A berstatus Aksesibel menurut data AksesBogor yang diperiksa tim.";
    expect(guardPlaceClaims(backed, checked)).toBe(backed);
  });

  it("drops claims such as bisa dilewati kursi roda", () => {
    expect(guardPlaceClaims("Pintu masuknya bisa dilewati kursi roda.", unchecked)).toBe(PLACE_CLAIM_NOTE);
  });
});

describe("guardAssistantAnswer", () => {
  it("never calls a route accessible, even when the place was checked", () => {
    const answer = guardAssistantAnswer("Masjid contoh A berstatus Aksesibel. Rute ke sana aman dilalui kursi roda.", checked);
    expect(answer).toBe(`Masjid contoh A berstatus Aksesibel.\n\n${ROUTE_CLAIM_NOTE}`);
  });

  it("keeps the route note when a place claim was also dropped", () => {
    const answer = guardAssistantAnswer("Halte X ramah kursi roda. Jalur ke halte itu bebas hambatan.", unchecked);
    expect(answer).toContain(PLACE_CLAIM_NOTE);
    expect(answer).not.toContain("ramah kursi roda.");
    expect(answer).not.toContain("bebas hambatan.");
  });

  it("replaces the word cacat", () => {
    expect(guardAssistantAnswer("Fasilitas untuk penyandang cacat belum diketahui.", unchecked)).toBe("Fasilitas untuk penyandang disabilitas belum diketahui.");
  });
});

describe("plainTerms", () => {
  it("replaces cacat with disabilitas and keeps capitals", () => {
    expect(plainTerms("Orang cacat dan kecacatan. Cacat fisik.")).toBe("Penyandang disabilitas dan disabilitas. Disabilitas fisik.");
    expect(plainTerms("Tidak ada kata itu.")).toBe("Tidak ada kata itu.");
  });
});
