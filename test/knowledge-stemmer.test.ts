import { describe, expect, it } from "vitest";
import { ROOT_WORDS } from "../src/knowledge/kata-dasar.js";
import { stem, stemText } from "../src/knowledge/stemmer.js";

const expectStems = (pairs: Record<string, string>) => {
  for (const [word, root] of Object.entries(pairs)) expect([word, stem(word)]).toEqual([word, root]);
};

describe("stem", () => {
  it("removes prefixes, suffixes and confixes", () => {
    expectStems({
      menggunakan: "guna",
      digunakan: "guna",
      pengguna: "guna",
      kemiringan: "miring",
      kelandaian: "landai",
      ketinggian: "tinggi",
      penyandang: "sandang",
      dilengkapi: "lengkap",
      beristirahat: "istirahat",
      pertemuan: "temu",
      memperhatikan: "hati",
      bangunan: "bangun",
      pemasangan: "pasang",
      dikaburkan: "kabur",
      menekan: "tekan",
    });
  });

  it("removes -i only together with a prefix, and keeps -si loanwords whole", () => {
    expectStems({ tinggi: "tinggi", lantai: "lantai", kursi: "kursi", verifikasi: "verifikasi", diverifikasi: "verifikasi" });
  });

  it("removes -nya and particles but not -ku or -mu", () => {
    expectStems({ rampnya: "ramp", lebarnya: "lebar", bermasalah: "masalah", sekolahnya: "sekolah", bertemu: "temu" });
  });

  it("does not strip a prefix when the rest cannot start a root word", () => {
    expectStems({ seksual: "seksual", sertifikat: "sertifikat" });
  });

  it("returns short words, numbers and words with digits unchanged", () => {
    for (const word of ["ram", "uu", "wc", "2016", "k1"]) expect(stem(word)).toBe(word);
  });

  it("uses the root word list when a nasal prefix hides the first letter", () => {
    expectStems({
      menilai: "nilai",
      penilaian: "nilai",
      pengunjung: "kunjung",
      memiliki: "milik",
      pemilik: "milik",
      berupa: "rupa",
      memaksimalkan: "maksimal",
      menyediakan: "sedia",
      ketersediaan: "sedia",
    });
  });

  it("uses the root word list for roots that end like a suffix", () => {
    expectStems({ jalan: "jalan", pegangan: "pegang", dipakai: "pakai", kerusakan: "rusak", membatasi: "batas", kereta: "kereta", disabilitas: "disabilitas" });
  });

  it("keeps function words that look affixed apart from their roots", () => {
    expectStems({ termasuk: "termasuk", keluar: "keluar", dikeluarkan: "keluar", sebelumnya: "sebelum" });
  });
});

describe("stemText", () => {
  it("lowercases, splits on anything but letters and digits, and stems each word", () => {
    expect(stemText("Kemiringan ram di luar Bangunan Gedung: 1:12.")).toBe("miring ram di luar bangun gedung 1 12");
  });
});

describe("ROOT_WORDS", () => {
  it("holds lowercase words only", () => {
    expect(ROOT_WORDS.size).toBeGreaterThan(100);
    for (const word of ROOT_WORDS) expect(word).toMatch(/^[a-z]+$/);
  });
});
