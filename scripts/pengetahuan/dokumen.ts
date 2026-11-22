// Dokumen AksesBogor untuk agen rute (ADR-0042), dibaca dari repo publik di GitHub cabang `main`:
// - halaman edukasi Aksesibilitas, Disabilitas, dan Tips dari `messages/id.json` di akses-bogor-web (ADR-0041);
// - Panduan Verifikasi, serta ADR-0017, ADR-0018, dan ADR-0022 dari akses-bogor-docs.
//
//   pnpm pengetahuan:dokumen             # unduh, simpan salinan mentah, lalu muat
//   pnpm pengetahuan:dokumen --salinan   # muat dari salinan mentah terakhir tanpa mengunduh
import { educationPassages, splitMarkdown } from "../../src/knowledge/documents.js";
import { insertPassages, replaceSource, type Passage } from "../../src/knowledge/store.js";
import { obtain, withDb } from "./unduh.js";

const RAW = "https://raw.githubusercontent.com/al-dioooo/";
const BLOB = "https://github.com/al-dioooo/";
const WEB = "https://akses-bogor.aldio.dev/";
const LICENSE = "Milik tim AksesBogor (repo publik tanpa lisensi terbuka)";
/** Bagian ADR yang tidak dipakai: opsi yang tidak dipilih bisa terbaca sebagai aturan. */
const ADR_SKIP = /^(Referensi|Opsi yang Dipertimbangkan|Pro & Kontra tiap Opsi)$/;

const ADRS = [
  ["0017", "0017-empat-jawaban-ketersediaan-fasilitas.md"],
  ["0018", "0018-status-pintu-masuk-dulu-dan-ringkasan-fasilitas.md"],
  ["0022", "0022-tersedia-berarti-bisa-dipakai.md"],
] as const;

type Doc = { id: string; title: string; url: string; retrievedAt: Date; sha256: string; passages: Passage[] };

await withDb(async (db) => {
  const docs: Doc[] = [];

  const messages = await obtain("akses-bogor-web-messages-id.json", `${RAW}akses-bogor-web/main/messages/id.json`);
  const json = JSON.parse(messages.bytes.toString("utf8")) as Record<string, unknown>;
  for (const [namespace, path] of [["Aksesibilitas", "aksesibilitas"], ["Disabilitas", "disabilitas"], ["Tips", "tips"]] as const) {
    const passages = educationPassages(json, namespace);
    const title = String((json[namespace] as { metaTitle?: string }).metaTitle ?? namespace);
    docs.push({
      id: `aksesbogor-halaman-${path}`,
      title: `Halaman edukasi "${title}" (draf, menunggu tinjauan komunitas; ADR-0041)`,
      retrievedAt: messages.retrievedAt,
      sha256: messages.sha256,
      url: `${WEB}${path}`,
      passages,
    });
  }

  const guide = await obtain("panduan-verifikasi.md", `${RAW}akses-bogor-docs/main/operations/panduan-verifikasi.md`);
  docs.push({
    id: "aksesbogor-panduan-verifikasi",
    title: "Panduan Verifikasi AksesBogor",
    retrievedAt: guide.retrievedAt,
    sha256: guide.sha256,
    url: `${BLOB}akses-bogor-docs/blob/main/operations/panduan-verifikasi.md`,
    passages: splitMarkdown(guide.bytes.toString("utf8"), "Panduan Verifikasi"),
  });

  for (const [number, file] of ADRS) {
    const adr = await obtain(`adr-${number}.md`, `${RAW}akses-bogor-docs/main/decisions/${file}`);
    const markdown = adr.bytes.toString("utf8");
    const title = /^# (.+)$/m.exec(markdown)?.[1] ?? `ADR-${number}`;
    docs.push({ id: `aksesbogor-adr-${number}`, title, retrievedAt: adr.retrievedAt, sha256: adr.sha256, url: `${BLOB}akses-bogor-docs/blob/main/decisions/${file}`, passages: splitMarkdown(markdown, `ADR-${number}`, ADR_SKIP) });
  }

  for (const doc of docs) {
    if (doc.passages.length === 0) throw new Error(`${doc.title}: tidak ada teks yang bisa dipotong; data lama tidak diubah.`);
    await replaceSource(
      db,
      { id: doc.id, kind: "dokumen_aksesbogor", title: doc.title, url: doc.url, license: LICENSE, retrievedAt: doc.retrievedAt, sha256: doc.sha256 },
      (tx) => insertPassages(tx, doc.id, doc.passages),
    );
    console.log(`${doc.title}: ${doc.passages.length} potongan.`);
  }
});
