// Daftar kata dasar untuk stemmer (ADR-0044). Bukan kamus lengkap: isinya kata dasar yang bentuk berimbuhannya ada di
// basis pengetahuan atau sering ditanyakan, dan yang tanpa daftar ini akan salah potong. Contohnya kata dasar yang
// berakhir seperti akhiran ("pakai", "rusak" dalam "kerusakan"), atau yang huruf awalnya luluh oleh awalan nasal
// ("nilai" dalam "menilai", "kunjung" dalam "pengunjung"). Tambahkan kata baru di kelompok yang sesuai, lalu jalankan
// `pnpm pengetahuan:indeks` dan `pnpm pengetahuan:evaluasi`.

/** Berakhir -i, -an, -kan, atau -nya, tetapi bagian kata dasar. */
const ENDS_LIKE_SUFFIX = `
  bagi beri bunyi cari diri ganti isi kunci kursi lantai mandi mulai nilai pakai pantai ramai sampai selesai sisi
  tepi tinggi hati mati kaki kali lalu capai kendali kecuali pegawai kemudi
  dengan jalan taman badan tangan kanan teman bulan aman tahan pesan ringan depan halaman jembatan pedoman relevan
  perempuan pahlawan wisatawan veteran pedestrian peran simpan median varian restoran kawasan selokan
  batas awas atas tugas
`;

/** Berakhir -k, sehingga "k" + "-an" mirip akhiran "-kan", mis. "kerusakan" atau "gerakan". */
const ENDS_IN_K = `
  rusak gerak masuk tindak letak anak banyak cetak tolak tidak injak kotak duduk pendek dekat didik pijak undak
  tunjuk percik rujuk bentuk bijak ledak gunduk patok pasok tumpuk busuk laik
`;

/** Huruf awalnya luluh atau mirip awalan: "menilai", "memiliki", "pengunjung", "berupa", "pegangan". */
const NASAL_OR_PREFIX_LIKE = `
  milik kenal kurang kirim kunjung kena rupa rasa pegang perlu pintu pandu tahu kembang kelola rancang rencana
  rawat rintis rumah perabot mudah maju mungkin minimal maksimal muda nikmat kandung muat minta kuat kabur kerja kering
  rendah koordinasi pengaruh pelihara seberang sepakat penjara perosok sembunyi
  disabilitas difabel diskriminasi dimensi diameter terminal terima menteri selasar setara sementara kendara
  sejahtera kereta keluarga sepeda sendiri seluruh terampil kepala kelompok permanen sertifikat persentase percaya
  perangkat berangkat kembali sederhana sensorik selamat ketika pertama terjemah sedia
`;

/** Kata tugas yang bentuknya mirip kata berimbuhan, supaya tidak bercampur dengan kata dasarnya ("termasuk" dan "masuk"). */
const FUNCTION_WORDS = `
  termasuk keluar sebelum selalu terlalu berikut
`;

/** Berakhir seperti partikel -lah atau -kah. */
const ENDS_LIKE_PARTICLE = `
  sekolah masalah jumlah langkah istilah
`;

export const ROOT_WORDS: ReadonlySet<string> = new Set(
  [ENDS_LIKE_SUFFIX, ENDS_IN_K, NASAL_OR_PREFIX_LIKE, ENDS_LIKE_PARTICLE, FUNCTION_WORDS].join(" ").split(/\s+/).filter(Boolean),
);
