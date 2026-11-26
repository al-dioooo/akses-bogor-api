import { describe, expect, it } from "vitest";
import { ManifestError, monthName, parseManifest, photoAlt, photoCaption } from "../src/hints/street-view-manifest.js";
import { kesatuanSettled, manifestOf, siloamSettled, unsettled } from "./helpers/street-view.js";

const problemsOf = (input: unknown) => {
  try {
    parseManifest(input);
  } catch (error) {
    if (error instanceof ManifestError) return error.problems;
    throw error;
  }
  return [];
};

describe("parseManifest (ADR-0057)", () => {
  it("reads settled and unsettled records with their targets, ordered answers, and the oldest image month", () => {
    const manifest = parseManifest(
      manifestOf([
        siloamSettled({ photos: [...siloamSettled().photos.slice(0, 1), { ...siloamSettled().photos[1], image_date: "2025-09" }] }),
        kesatuanSettled(),
        unsettled("05", { osm: "way/782982224" }),
        unsettled("11", { place_id: "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b" }, "Tempat admin tanpa gambar pintu masuk."),
      ]),
    );
    expect(manifest.round).toBe("2026-11-27-uji");
    const [siloam, kesatuan, pmi, admin] = manifest.records;
    expect(siloam).toMatchObject({ verdict: "settled", target: { kind: "osm", osmType: "node", osmId: 4994301869 }, imageMonth: "2025-09" });
    if (siloam?.verdict !== "settled" || kesatuan?.verdict !== "settled") throw new Error("expected settled");
    expect(siloam.facilities.map((f) => `${f.facility}=${f.answer}`)).toEqual(["ramp=tidak_perlu", "toilet_difabel=belum_tahu", "guiding_block=belum_tahu", "lift=belum_tahu"]);
    expect(siloam.photos.map((p) => p.tag)).toEqual(["pintu_masuk", "pintu_masuk"]);
    expect(kesatuan.facilities[0]).toEqual({ facility: "ramp", answer: "tidak_tersedia", reason: "tidak_ada", note: null });
    expect(pmi).toEqual({ record: "05", target: { kind: "osm", osmType: "way", osmId: 782982224 }, reason: "Pintu masuk tidak terlihat dari jalan.", verdict: "unsettled" });
    expect(admin!.target).toEqual({ kind: "place", placeId: "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b" });
  });

  it("refuses the wrong version, unknown keys, bad targets, and unsettled records that carry answers", () => {
    expect(problemsOf({ ...manifestOf([unsettled("01", { osm: "node/1" })]), version: 2 })[0]).toMatch(/^version/);
    expect(problemsOf(manifestOf([{ ...siloamSettled(), facility: {} }])).join()).toMatch(/facility/);
    expect(problemsOf(manifestOf([unsettled("01", { osm: "node/abc" })])).join()).toMatch(/node\/123/);
    expect(problemsOf(manifestOf([{ ...unsettled("01", { osm: "node/1" }), facilities: siloamSettled().facilities }])).length).toBeGreaterThan(0);
    expect(problemsOf({ ...manifestOf([unsettled("01", { osm: "node/1" })]), round: "putaran 1" }).join()).toMatch(/round/);
  });

  it("enforces the judgement rules and reports every problem with its record", () => {
    const bad = siloamSettled({
      facilities: { ramp: { answer: "belum_tahu" }, toilet_difabel: { answer: "tersedia" }, guiding_block: { answer: "tersedia" }, lift: { answer: "tidak_tersedia" } },
      photos: [{ file: "lama.png", kind: "wide", pano_id: "x", image_date: "2018-06", heading: 0 }],
    });
    expect(problemsOf(manifestOf([bad]))).toEqual([
      "data 02: data terjawab butuh jawaban pintu masuk (ramp), bukan belum_tahu",
      "data 02: toilet_difabel selalu belum_tahu dari Street View",
      "data 02: lift selalu belum_tahu dari Street View",
      "data 02: lift tidak_tersedia butuh reason",
      "data 02: guiding_block tersedia atau tidak_perlu butuh foto bertag guiding_block",
      "data 02: lama.png: gambar 2018-06 lebih tua dari 2022-01, bukan bukti",
    ]);
  });

  it("accepts guiding block evidence only from a photo tagged guiding_block, as at a halte", () => {
    const halte = siloamSettled({
      facilities: { ...siloamSettled().facilities, guiding_block: { answer: "tersedia" } },
      photos: [...siloamSettled().photos, { file: "02-paving.png", kind: "other", pano_id: "x", image_date: "2026-01", heading: 10, tag: "guiding_block" }],
    });
    expect(problemsOf(manifestOf([halte]))).toEqual([]);
  });

  it("refuses a reason on an answer other than tidak_tersedia, and duplicate records, targets or files", () => {
    const reasonOnNeeded = siloamSettled({ facilities: { ...siloamSettled().facilities, ramp: { answer: "tidak_perlu", reason: "rusak" } } });
    expect(problemsOf(manifestOf([reasonOnNeeded]))).toEqual(["data 02: ramp: reason hanya untuk tidak_tersedia"]);
    expect(problemsOf(manifestOf([unsettled("01", { osm: "node/1" }), unsettled("01", { osm: "node/2" }), unsettled("03", { osm: "node/2" })]))).toEqual([
      "data 01: nomor data dipakai dua kali",
      "data 03: sasaran node/2 sudah dipakai data lain",
    ]);
    const twice = siloamSettled({ photos: [siloamSettled().photos[0], siloamSettled().photos[0]] });
    expect(problemsOf(manifestOf([twice]))).toEqual(["data 02: berkas foto yang sama dipasang dua kali"]);
  });
});

describe("photo text", () => {
  const [wide, close] = siloamSettled().photos as [Parameters<typeof photoAlt>[0], Parameters<typeof photoAlt>[0]];

  it("names Street View and the image month in the caption", () => {
    expect(monthName("2026-01")).toBe("Januari 2026");
    expect(monthName("2025-12")).toBe("Desember 2025");
    expect(photoCaption(wide)).toBe("Sumber: Google Street View, gambar Januari 2026");
  });

  it("describes the entrance and the view in the alt text, unless the manifest gives one", () => {
    expect(photoAlt({ ...wide, tag: "pintu_masuk" }, "Siloam Hospitals Bogor")).toBe("Pintu masuk Siloam Hospitals Bogor dilihat dari jalan, tangkapan Google Street View Januari 2026");
    expect(photoAlt({ ...close, tag: "pintu_masuk" }, "Siloam Hospitals Bogor")).toBe("Pintu masuk Siloam Hospitals Bogor dari dekat, tangkapan Google Street View Januari 2026");
    expect(photoAlt({ ...wide, tag: "pintu_masuk", alt: "Pintu kaca di bawah kanopi" }, "Siloam")).toBe("Pintu kaca di bawah kanopi");
  });
});
