import { describe, expect, it } from "vitest";
import { MAX_SECTION, educationPassages, plainMarkdown, splitMarkdown } from "../src/knowledge/documents.js";

describe("plainMarkdown", () => {
  it("keeps the words of links, emphasis, code and tables", () => {
    const markdown = "Lihat [ADR-0017](0017.md) dan **Tersedia** atau *Belum tahu* di `place_facilities`.\n\n| Jawaban | Arti |\n| --- | --- |\n| Tersedia | Bisa dipakai |\n<!-- catatan -->";
    expect(plainMarkdown(markdown)).toBe("Lihat ADR-0017 dan Tersedia atau Belum tahu di place_facilities.\n\nJawaban — Arti\nTersedia — Bisa dipakai");
  });
});

describe("splitMarkdown", () => {
  const adr = `# ADR-0017: Empat Jawaban

- Status: Accepted
- Tanggal: 2026-10-21

## Konteks dan Masalah

Fasilitas belum tentu diketahui.

## Opsi yang Dipertimbangkan

1. Dua jawaban

## Keputusan

Empat jawaban.

### Arti setiap jawaban

"Belum tahu" bukan "Tidak tersedia".

## Pro & Kontra tiap Opsi

### Dua jawaban

- Kontra: memaksa menebak.

## Referensi

- [PRD](../product/prd.md)
`;

  it("cites each section by its heading path and skips metadata and skipped sections", () => {
    const passages = splitMarkdown(adr, "ADR-0017", /^(Referensi|Opsi yang Dipertimbangkan|Pro & Kontra tiap Opsi)$/);
    expect(passages).toEqual([
      { citation: "ADR-0017, Konteks dan Masalah", heading: "Konteks dan Masalah", body: "Fasilitas belum tentu diketahui." },
      { citation: "ADR-0017, Keputusan", heading: "Keputusan", body: "Empat jawaban." },
      { citation: "ADR-0017, Keputusan › Arti setiap jawaban", heading: "Keputusan › Arti setiap jawaban", body: '"Belum tahu" bukan "Tidak tersedia".' },
    ]);
  });

  it("splits a long section at paragraph boundaries", () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraf ${i + 1}. ${"Isi panduan verifikasi. ".repeat(8)}`);
    const passages = splitMarkdown(`## 5. Bukti Foto\n\n${paragraphs.join("\n\n")}`, "Panduan Verifikasi");
    expect(passages.length).toBeGreaterThan(1);
    expect(passages[0]!.citation).toBe(`Panduan Verifikasi, 5. Bukti Foto (bagian 1 dari ${passages.length})`);
    expect(passages.every((p) => p.body.length <= MAX_SECTION)).toBe(true);
  });
});

describe("educationPassages", () => {
  const messages = {
    Fasilitas: { ramp: "Ramp / Jalur Landai", lift: "Lift / Elevator" },
    Jawaban: { tersedia: "Tersedia", belum_tahu: "Belum diketahui" },
    Status: { aksesibel: "Aksesibel" },
    Aksesibilitas: {
      metaTitle: "Mengenal aksesibilitas",
      title: "Mengenal",
      intro: "Cara AksesBogor menilai tempat.",
      facilities: {
        title: "Empat fasilitas",
        whoLabel: "Paling membantu:",
        items: { ramp: { what: "Jalan masuk tanpa anak tangga.", who: "pengguna kursi roda." } },
      },
      answers: { title: "Empat jawaban", items: { tersedia: "Bisa dipakai.", belum_tahu: "Belum bisa dipastikan." } },
      words: { title: "Kata", items: [{ term: "Difabel", body: "Hanya di nama fasilitas." }] },
      limits: { title: "Batas", items: ["Bukan penilaian <b>resmi</b>."], needsLink: "Kebutuhan lain" },
      sources: [{ text: "UU No. 8 Tahun 2016, Pasal 18.", link: "PDF", href: "https://peraturan.go.id/files/uu8-2016bt.pdf" }],
    },
  };

  it("turns each titled section into a passage with codes replaced by their labels", () => {
    const passages = educationPassages(messages, "Aksesibilitas");
    expect(passages.map((p) => [p.citation, p.body])).toEqual([
      ['Halaman "Mengenal aksesibilitas" (draf), pembuka', "Cara AksesBogor menilai tempat."],
      ['Halaman "Mengenal aksesibilitas" (draf), Empat fasilitas', "Ramp / Jalur Landai: Jalan masuk tanpa anak tangga. Paling membantu: pengguna kursi roda."],
      ['Halaman "Mengenal aksesibilitas" (draf), Empat jawaban', "Tersedia: Bisa dipakai.\nBelum diketahui: Belum bisa dipastikan."],
      ['Halaman "Mengenal aksesibilitas" (draf), Kata', "Difabel: Hanya di nama fasilitas."],
      ['Halaman "Mengenal aksesibilitas" (draf), Batas', "Bukan penilaian resmi."],
      ['Halaman "Mengenal aksesibilitas" (draf), Sumber', "UU No. 8 Tahun 2016, Pasal 18."],
    ]);
    expect(passages[1]!.heading).toBe("Mengenal aksesibilitas › Empat fasilitas");
  });

  it("fails loudly when the page is missing", () => {
    expect(() => educationPassages(messages, "Tips")).toThrow("Namespace Tips");
  });
});
