// Daftar kata dasar untuk stemmer (ADR-0044). Bukan kamus lengkap: isinya kata dasar yang bentuk berimbuhannya ada di
// basis pengetahuan atau sering ditanyakan, dan yang tanpa daftar ini akan salah potong. Contohnya kata dasar yang
// berakhir seperti akhiran ("pakai", "rusak" dalam "kerusakan"), atau yang huruf awalnya luluh oleh awalan nasal
// ("nilai" dalam "menilai", "kunjung" dalam "pengunjung"). Tambahkan kata baru di kelompok yang sesuai, lalu jalankan
// `pnpm pengetahuan:indeks` dan `pnpm pengetahuan:evaluasi`.

/** Kata tugas yang bentuknya mirip kata berimbuhan, supaya tidak bercampur dengan kata dasarnya ("termasuk" dan "masuk"). */
const FUNCTION_WORDS = `
  termasuk keluar sebelum selalu terlalu berikut
`;

/** Berakhir seperti partikel -lah atau -kah. */
const ENDS_LIKE_PARTICLE = `
  sekolah masalah jumlah langkah istilah
`;

export const ROOT_WORDS: ReadonlySet<string> = new Set(
  [ENDS_LIKE_PARTICLE, FUNCTION_WORDS].join(" ").split(/\s+/).filter(Boolean),
);
