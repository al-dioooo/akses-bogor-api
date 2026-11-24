import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { averageScores, citationMatches, scoreQuestion, type Target } from "../scripts/pengetahuan/metrik-retrieval.js";

const RAM_1 = "Permen PUPR No. 14/PRT/M/2017, Lampiran II, B.2 Ram (bagian 1 dari 2)";
const RAM_2 = "Permen PUPR No. 14/PRT/M/2017, Lampiran II, B.2 Ram (bagian 2 dari 2)";
const PASAL_18 = "UU No. 8 Tahun 2016, Pasal 18";

describe("citationMatches", () => {
  it("matches exact citations and every part of a citation given without a part number", () => {
    expect(citationMatches(PASAL_18, PASAL_18)).toBe(true);
    expect(citationMatches(RAM_2, "Permen PUPR No. 14/PRT/M/2017, Lampiran II, B.2 Ram")).toBe(true);
    expect(citationMatches(RAM_2, RAM_1)).toBe(false);
    expect(citationMatches("UU No. 8 Tahun 2016, Pasal 180", PASAL_18)).toBe(false);
  });
});

describe("scoreQuestion", () => {
  it("computes recall at each cut-off and the reciprocal rank of the first relevant hit", () => {
    const citations = ["a", "b", RAM_1, "c", PASAL_18];
    const score = scoreQuestion(citations, [RAM_1, PASAL_18], [3, 5]);
    expect(score.recall).toEqual({ 3: 0.5, 5: 1 });
    expect(score.reciprocalRank).toBeCloseTo(1 / 3);
    expect(score.firstRank).toBe(3);
  });

  it("counts a target with alternatives once, when any alternative is found", () => {
    const targets: Target[] = [[PASAL_18, "Halaman lain"]];
    expect(scoreQuestion(["Halaman lain", PASAL_18], targets, [1]).recall).toEqual({ 1: 1 });
  });

  it("scores zero when nothing relevant is retrieved", () => {
    expect(scoreQuestion(["a", "b"], [RAM_1], [3])).toEqual({ recall: { 3: 0 }, reciprocalRank: 0, firstRank: null });
  });
});

describe("averageScores", () => {
  it("averages recall and reciprocal rank over questions", () => {
    const scores = [scoreQuestion([RAM_1], [RAM_1], [3]), scoreQuestion(["x", RAM_1], [RAM_1], [3]), scoreQuestion([], [RAM_1], [3])];
    const avg = averageScores(scores, [3]);
    expect(avg.recall[3]).toBeCloseTo(2 / 3);
    expect(avg.mrr).toBeCloseTo(0.5);
  });
});

describe("retrieval test sets", () => {
  it("give every question a unique id and at least one target citation", () => {
    for (const file of ["uji-retrieval.json", "uji-retrieval-terpisah.json"]) {
      const questions = JSON.parse(readFileSync(new URL(`../scripts/pengetahuan/${file}`, import.meta.url), "utf8")) as { id: string; pertanyaan: string; relevan: Target[] }[];
      expect(new Set(questions.map((q) => q.id)).size).toBe(questions.length);
      for (const q of questions) {
        expect(q.pertanyaan.length).toBeGreaterThan(0);
        expect(q.relevan.length).toBeGreaterThan(0);
      }
    }
  });

  it("do not expect citations from the Disabilitas and Tips pages, which were removed from the site", () => {
    for (const file of ["uji-retrieval.json", "uji-retrieval-terpisah.json"]) {
      const text = readFileSync(new URL(`../scripts/pengetahuan/${file}`, import.meta.url), "utf8");
      expect(text).not.toMatch(/Mengenal disabilitas|Tips berkunjung dan melapor/);
    }
  });
});
