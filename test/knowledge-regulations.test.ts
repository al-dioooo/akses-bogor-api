import { describe, expect, it } from "vitest";
import { MAX_PASSAGE, cleanLines, reflow, splitAppendix, splitArticles } from "../src/knowledge/regulations.js";

// Potongan teks seperti hasil ekstraksi PDF peraturan.go.id: kepala dan kaki halaman, baris terpotong, dan judul.
const statute = [
  `LEMBARAN NEGARA
UNDANG-UNDANG REPUBLIK INDONESIA
NOMOR 8 TAHUN 2016
PRESIDEN REPUBLIK INDONESIA,
Menimbang : a. bahwa negara menjamin hak setiap warga
negara;
b. bahwa Undang-
Undang Nomor 4 Tahun 1997 sudah tidak sesuai lagi;
Mengingat : Pasal 20 Undang-Undang Dasar;
MEMUTUSKAN:
BAB I
KETENTUAN UMUM
Pasal 1
Dalam Undang-Undang ini yang dimaksud dengan:
1. Penyandang Disabilitas adalah setiap orang yang
mengalami keterbatasan fisik.
2. Aksesibilitas adalah kemudahan yang disediakan.www.peraturan.go.id`,
  `2016, No.69 -2-
BAB II
HAK PENYANDANG DISABILITAS
Bagian Kesatu
Hak Aksesibilitas
Pasal 2
Hak Aksesibilitas meliputi hak mendapatkan Aksesibilitas
untuk memanfaatkan fasilitas publik sebagaimana dimaksud dalam
Pasal 1
dan hak lain.
Pasal 3
(1) Ayat pertama.
(2) Ayat kedua.
Disahkan di Jakarta
pada tanggal 15 April 2016
www.peraturan.go.id`,
];

describe("cleanLines and reflow", () => {
  it("drops page headers, footers and page numbers", () => {
    const lines = cleanLines(["2016, No.69 -2-\nisi\n-57-\n- 2 -\n-II.3-\nJDIH Kementerian PUPR\nbaris akhir.www.peraturan.go.id"]);
    expect(lines).toEqual(["isi", "baris akhir."]);
  });

  it("joins wrapped lines, keeps items on their own line, and rejoins hyphenated words", () => {
    expect(reflow(["Hak meliputi", "hak:", "a. satu", "lanjutan;", "b. Undang-", "Undang lain."])).toBe("Hak meliputi hak:\na. satu lanjutan;\nb. Undang-Undang lain.");
  });
});

describe("splitArticles", () => {
  const passages = splitArticles(cleanLines(statute), "UU No. 8 Tahun 2016");

  it("keeps the preamble and every article with its chapter and section as heading", () => {
    expect(passages.map((p) => [p.citation, p.heading])).toEqual([
      ["UU No. 8 Tahun 2016, Menimbang", "Menimbang"],
      ["UU No. 8 Tahun 2016, Pasal 1", "KETENTUAN UMUM"],
      ["UU No. 8 Tahun 2016, Pasal 2", "HAK PENYANDANG DISABILITAS › Hak Aksesibilitas"],
      ["UU No. 8 Tahun 2016, Pasal 3", "HAK PENYANDANG DISABILITAS › Hak Aksesibilitas"],
    ]);
    expect(passages[0]!.body).toBe("a. bahwa negara menjamin hak setiap warga negara;\nb. bahwa Undang-Undang Nomor 4 Tahun 1997 sudah tidak sesuai lagi;");
  });

  it("does not start a new article at a cross-reference that falls at the start of a line", () => {
    expect(passages[2]!.body).toBe("Hak Aksesibilitas meliputi hak mendapatkan Aksesibilitas untuk memanfaatkan fasilitas publik sebagaimana dimaksud dalam Pasal 1 dan hak lain.");
  });

  it("stops at the signature block", () => {
    expect(passages.at(-1)!.body).toBe("(1) Ayat pertama.\n(2) Ayat kedua.");
  });

  it("splits a long article by numbered items and repeats its opening sentence", () => {
    const items = Array.from({ length: 30 }, (_, i) => `${i + 1}. Istilah ${i + 1} adalah ${"penjelasan panjang ".repeat(6)}`);
    const long = splitArticles(["Pasal 1", "Dalam Undang-Undang ini yang dimaksud dengan:", ...items], "UU X");
    expect(long.length).toBeGreaterThan(1);
    expect(long[0]!.citation).toMatch(/^UU X, Pasal 1 angka 1–\d+$/);
    expect(long.at(-1)!.citation).toMatch(/^UU X, Pasal 1 angka \d+–30$/);
    for (const p of long) {
      expect(p.body.length).toBeLessThanOrEqual(MAX_PASSAGE);
      expect(p.body.startsWith("Dalam Undang-Undang ini yang dimaksud dengan:\n")).toBe(true);
    }
  });

  it("splits a long article by ayat", () => {
    const ayat = Array.from({ length: 12 }, (_, i) => `(${i + 1}) ${"Ketentuan ayat yang panjang sekali. ".repeat(6)}`);
    const long = splitArticles(["Pasal 1", ...ayat], "UU X");
    expect(long[0]!.citation).toMatch(/^UU X, Pasal 1 ayat \(1\)–\(\d+\)$/);
  });
});

describe("splitAppendix", () => {
  const appendix = cleanLines([
    `-II.1-
JDIH Kementerian PUPR
LAMPIRAN II
PERATURAN MENTERI PEKERJAAN UMUM
NOMOR 14/PRT/M/2017
TENTANG
PERSYARATAN KEMUDAHAN BANGUNAN
GEDUNG
PENYEDIAAN FASILITAS DAN AKSESIBILITAS
A. Hubungan Horizontal
Sarana hubungan horizontal meliputi:
1) pintu;
2) jalur pemandu.
1. Pintu
a. Persyaratan Teknis
1) Pintu masuk utama memiliki lebar efektif bukaan paling sedikit 90 cm.
2. Jalur Pemandu
a. Persyaratan
1) Ubin pengarah bermotif garis.
B. Hubungan Vertikal
1. Ram
a. Persyaratan Teknis
1) Kemiringan ram di dalam bangunan gedung tidak melebihi 6°.
A. Akses eksit
MENTERI PEKERJAAN UMUM DAN
ttd.`,
  ]);
  const passages = splitAppendix(appendix, "Permen PUPR No. 14/PRT/M/2017", "II");

  it("cites each lettered and numbered section of the appendix", () => {
    expect(passages.map((p) => p.citation)).toEqual([
      "Permen PUPR No. 14/PRT/M/2017, Lampiran II, A Hubungan Horizontal",
      "Permen PUPR No. 14/PRT/M/2017, Lampiran II, A.1 Pintu",
      "Permen PUPR No. 14/PRT/M/2017, Lampiran II, A.2 Jalur Pemandu",
      "Permen PUPR No. 14/PRT/M/2017, Lampiran II, B.1 Ram",
    ]);
    expect(passages[3]!.heading).toBe("Penyediaan fasilitas dan aksesibilitas › Hubungan Vertikal › Ram");
  });

  it("keeps an out-of-order letter as text and drops the signature", () => {
    expect(passages[3]!.body).toBe("a. Persyaratan Teknis\n1) Kemiringan ram di dalam bangunan gedung tidak melebihi 6°.\nA. Akses eksit");
  });

  it("splits a long section into numbered parts", () => {
    const lines = ["LAMPIRAN I", "A. Ukuran", ...Array.from({ length: 40 }, (_, i) => `${i + 1}) ${"Ukuran ruang gerak yang cukup. ".repeat(3)}`)];
    const parts = splitAppendix(lines, "P", "I");
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]!.citation).toBe(`P, Lampiran I, A Ukuran (bagian 1 dari ${parts.length})`);
    expect(parts.every((p) => p.body.length <= MAX_PASSAGE)).toBe(true);
  });
});
