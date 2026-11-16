// Teks resmi regulasi aksesibilitas, dipotong per pasal dan per bagian lampiran (ADR-0042):
// - UU No. 8 Tahun 2016 tentang Penyandang Disabilitas, PDF dari peraturan.go.id;
// - Permen PUPR No. 14/PRT/M/2017 tentang Persyaratan Kemudahan Bangunan Gedung, ZIP dari JDIH Kementerian PU berisi
//   batang tubuh dan Lampiran I sampai IV. Salinan Berita Negara di peraturan.go.id tidak dipakai karena lampirannya
//   berupa gambar pindaian tanpa teks.
//
//   pnpm pengetahuan:regulasi             # unduh, simpan salinan mentah, lalu muat
//   pnpm pengetahuan:regulasi --salinan   # muat dari salinan mentah terakhir tanpa mengunduh
//
// Bila teks berkas tidak bisa dibaca utuh (jumlah pasal tidak sesuai), skrip berhenti tanpa mengubah data lama.
// Salinan tidak resmi tidak pernah dipakai sebagai pengganti.
import { unzipSync } from "fflate";
import { extractText, getDocumentProxy } from "unpdf";
import { cleanLines, splitAppendix, splitArticles } from "../../src/knowledge/regulations.js";
import { insertPassages, replaceSource, type Passage } from "../../src/knowledge/store.js";
import { obtain, withDb } from "./unduh.js";

const LICENSE = "Tidak ada hak cipta atas peraturan perundang-undangan (UU No. 28 Tahun 2014 tentang Hak Cipta, Pasal 42 huruf b)";

async function pdfPages(bytes: Uint8Array) {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: false });
  return text;
}

/** Jumlah pasal berbeda di potongan, untuk memastikan seluruh batang tubuh terbaca. */
const articleCount = (passages: Passage[]) => new Set(passages.flatMap((p) => /, Pasal (\d+[A-Z]?)/.exec(p.citation)?.[1] ?? [])).size;

function requireArticles(passages: Passage[], expected: number, name: string) {
  const found = articleCount(passages);
  if (found !== expected) throw new Error(`${name}: terbaca ${found} pasal, seharusnya ${expected}. Teks berkas tidak bisa dibaca utuh; data lama tidak diubah.`);
}

await withDb(async (db) => {
  const uu = await obtain("uu-8-2016.pdf", "https://peraturan.go.id/files/uu8-2016bt.pdf");
  const uuShort = "UU No. 8 Tahun 2016";
  const uuPassages = splitArticles(cleanLines(await pdfPages(new Uint8Array(uu.bytes))), uuShort);
  requireArticles(uuPassages, 153, uuShort);

  const permen = await obtain("permen-pupr-14-2017.zip", "https://jdih.pu.go.id/internal/assets/assets/produk/PermenPUPR/2017/08/PermenPUPR14-2017.zip", {
    timeoutMs: 180_000,
  });
  const permenShort = "Permen PUPR No. 14/PRT/M/2017";
  const files = unzipSync(new Uint8Array(permen.bytes));
  const file = (name: string) => {
    const bytes = files[name];
    if (!bytes) throw new Error(`${permenShort}: berkas ${name} tidak ada di ZIP JDIH.`);
    return bytes;
  };
  const permenPassages = splitArticles(cleanLines(await pdfPages(file("PermenPUPR14-2017.pdf"))), permenShort);
  requireArticles(permenPassages, 59, permenShort);
  for (const [n, roman] of [[1, "I"], [2, "II"], [3, "III"], [4, "IV"]] as const) {
    const appendix = splitAppendix(cleanLines(await pdfPages(file(`Lamp${n}-PermenPUPR14-2017.pdf`))), permenShort, roman);
    if (appendix.length === 0) throw new Error(`${permenShort}: Lampiran ${roman} tidak berisi teks.`);
    permenPassages.push(...appendix);
  }

  await replaceSource(
    db,
    {
      id: "uu-8-2016",
      kind: "regulasi",
      title: "Undang-Undang Nomor 8 Tahun 2016 tentang Penyandang Disabilitas",
      url: uu.url,
      license: LICENSE,
      attribution: "Teks resmi dari peraturan.go.id",
      retrievedAt: uu.retrievedAt,
      sha256: uu.sha256,
    },
    (tx) => insertPassages(tx, "uu-8-2016", uuPassages),
  );
  await replaceSource(
    db,
    {
      id: "permen-pupr-14-2017",
      kind: "regulasi",
      title: "Peraturan Menteri PUPR Nomor 14/PRT/M/2017 tentang Persyaratan Kemudahan Bangunan Gedung, dengan Lampiran I–IV",
      url: permen.url,
      license: LICENSE,
      attribution: "Teks resmi dari JDIH Kementerian Pekerjaan Umum (jdih.pu.go.id)",
      retrievedAt: permen.retrievedAt,
      sha256: permen.sha256,
    },
    (tx) => insertPassages(tx, "permen-pupr-14-2017", permenPassages),
  );
  console.log(`${uuShort}: ${uuPassages.length} potongan. ${permenShort}: ${permenPassages.length} potongan, termasuk Lampiran I–IV.`);
});
