// Menghitung ulang kolom bentuk dasar (`search_stem`, ADR-0044) untuk semua potongan basis pengetahuan dari teks yang
// sudah tersimpan. Tidak mengunduh apa pun. Jalankan sekali setelah migrasi 0009, dan setiap kali
// `src/knowledge/stemmer.ts` atau `src/knowledge/kata-dasar.ts` berubah. Aman dijalankan ulang.
//
//   pnpm pengetahuan:indeks
import { reindexStems } from "../../src/knowledge/store.js";
import { withDb } from "./unduh.js";

await withDb(async (db) => {
  const count = await reindexStems(db);
  console.log(`Bentuk dasar ${count} potongan dihitung ulang.`);
});
