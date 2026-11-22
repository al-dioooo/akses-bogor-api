// Padanan kata untuk memperluas pertanyaan ke basis pengetahuan (ADR-0044). Satu baris adalah satu kelompok yang
// dianggap sama saat mencari: bila pertanyaan memuat salah satunya, potongan yang memuat anggota lain juga cocok.
// Ungkapan beberapa kata dicocokkan sebagai frasa, dan semuanya dicocokkan juga dalam bentuk dasarnya, jadi
// "ubin pemandu" juga cocok dengan "ubin pandu". Daftar ini ditinjau manusia: tambahkan hanya padanan yang benar di
// konteks aksesibilitas, lalu jalankan `pnpm pengetahuan:evaluasi` untuk melihat dampaknya.

export const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  // Fasilitas yang dicatat AksesBogor (ADR-0017) dan istilahnya di Permen PUPR No. 14/PRT/M/2017.
  ["ram", "ramp", "jalur landai", "bidang miring"],
  ["toilet", "wc", "kamar mandi", "kamar kecil", "kloset", "jamban"],
  ["guiding block", "ubin pemandu", "jalur pemandu", "ubin pengarah", "ubin peringatan", "warning block", "ubin taktil"],
  ["lift", "lif", "elevator"],
  ["pegangan rambat", "handrail", "railing", "pegangan tangan"],
  ["trotoar", "jalur pedestrian", "pejalan kaki"],
  ["kemiringan", "kelandaian", "curam"],

  // Penyandang disabilitas: kata sehari-hari dan istilah undang-undang. "Penyandang cacat" hanya untuk mencari teks
  // lama; AksesBogor tidak memakai kata itu (ADR-0041).
  ["difabel", "disabilitas", "penyandang disabilitas", "penyandang cacat"],
  ["tunanetra", "netra", "disabilitas netra", "low vision", "gangguan penglihatan"],
  ["kursi roda", "pengguna kursi roda"],
  ["lansia", "lanjut usia"],

  // Angkutan umum di Kota Bogor (data OpenStreetMap) dan istilahnya di UU No. 8 Tahun 2016.
  ["halte", "shelter", "tempat pemberhentian", "bus stop"],
  ["angkot", "angkutan kota"],
  ["biskita", "bis kita", "trans pakuan", "transpakuan"],
  ["angkutan umum", "transportasi umum", "transportasi publik", "kendaraan umum"],

  // Bahasa peraturan untuk batas ukuran: Permen PUPR menulis "paling sedikit" dan "paling besar", bukan "minimal".
  ["minimal", "minimum", "paling sedikit", "paling kecil", "paling rendah", "paling kurang", "sekurang kurangnya", "tidak boleh kurang"],
  ["maksimal", "maksimum", "paling besar", "paling tinggi", "paling banyak", "paling jauh", "tidak lebih dari", "tidak boleh melebihi"],
];
