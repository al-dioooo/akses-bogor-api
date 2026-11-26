// Memuat atribut aksesibilitas Google Maps dari dataset Apify (`pnpm petunjuk:google-ambil`) ke tag kandidat OSM
// (ADR-0056). Satu transaksi, aman dijalankan ulang. Jalankan dulu dengan --dry-run dan periksa pasangannya.
//
//   pnpm petunjuk:google-impor --dry-run                  # berkas terbaru di ~/data/akses-bogor/google-maps
//   pnpm petunjuk:google-impor <berkas.json> --dry-run
//   pnpm petunjuk:google-impor <berkas.json>
//
// --timpa-cara-lain juga mengganti salinan dari cara lain (mis. salinan 2026-11-23) yang belum diperiksa tim.
// Salinan yang sudah diperiksa tim tidak pernah diganti.
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadEnv } from "../../src/config/env.js";
import { createDb } from "../../src/db/client.js";
import { DEFAULT_OUTPUT_DIR } from "../../src/hints/apify.js";
import { importGoogleMaps, MATCH_METERS, parseApifyItems, summarize, type Unmatched } from "../../src/hints/google-maps-import.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { "dry-run": { type: "boolean", default: false }, "timpa-cara-lain": { type: "boolean", default: false } },
});

const REASONS: Record<Unmatched["reason"], string> = {
  kategori: "kategori Google bukan kampus, masjid, halte, atau rumah sakit",
  jarak: `tidak ada tempat OSM berkategori sama dalam ${MATCH_METERS} m`,
  nama: "nama tidak mirip",
  ambigu: "tempat OSM-nya sudah diambil hasil Google lain yang lebih dekat",
};

/** Berkas dari argumen, atau dataset terbaru di folder bawaan. */
async function inputFile() {
  if (positionals[0]) return resolve(positionals[0]);
  const names = (await readdir(DEFAULT_OUTPUT_DIR).catch(() => [])).filter((n) => n.endsWith(".json") && !n.endsWith(".meta.json")).sort();
  if (names.length === 0) throw new Error(`Tidak ada dataset di ${DEFAULT_OUTPUT_DIR}. Jalankan dulu \`pnpm petunjuk:google-ambil\`, atau sebutkan berkasnya.`);
  return join(DEFAULT_OUTPUT_DIR, names.at(-1)!);
}

async function main() {
  const path = await inputFile();
  const items: unknown = JSON.parse(await readFile(path, "utf8"));
  const meta = await readFile(path.replace(/\.json$/, ".meta.json"), "utf8").then((t) => JSON.parse(t) as { selesai?: string }, () => null);
  const { places, skipped } = parseApifyItems(items, meta?.selesai ? new Date(meta.selesai) : undefined);
  const dryRun = values["dry-run"];

  const { db, pool } = createDb(loadEnv().DATABASE_URL);
  const report = await importGoogleMaps(db, places, { dryRun, replaceOtherMethods: values["timpa-cara-lain"] }).finally(() => pool.end());
  const summary = summarize(report);

  for (const m of report.matches) {
    console.log(`cocok   ${m.osm.osmType}/${m.osm.osmId} ${m.osm.category} "${m.osm.name}" ← "${m.place.name}" ${Math.round(m.meters)} m [${m.decision}]`);
  }
  for (const u of report.unmatched) console.log(`${u.reason === "ambigu" ? "ambigu " : "tidak  "} "${u.place.name}" (${u.place.categories[0] ?? "tanpa kategori"}): ${REASONS[u.reason]}`);

  const total = Array.isArray(items) ? items.length : 0;
  console.log(`\nBerkas: ${path}`);
  console.log(`${total} hasil, ${places.length} tempat Google. Dibuang: ${skipped.incomplete} tanpa nama, titik, atau waktu ambil; ${skipped.closed} tutup permanen; ${skipped.duplicates} ganda.`);
  console.log(`Cocok: ${report.matches.length}. Ambigu: ${summary.reasons.ambigu}. Tidak cocok: ${summary.reasons.kategori + summary.reasons.jarak + summary.reasons.nama} (kategori lain ${summary.reasons.kategori}, jarak ${summary.reasons.jarak}, nama ${summary.reasons.nama}).`);
  for (const [category, c] of summary.categories) {
    const f = c.flags;
    console.log(
      `  ${category}: ${c.cocok} cocok, ${c.denganAtribut} dengan atribut. Ada/tidak: pintu masuk ${f.entrance.ada}/${f.entrance.tidak}, toilet ${f.restroom.ada}/${f.restroom.tidak}, parkir ${f.parking.ada}/${f.parking.tidak}, tempat duduk ${f.seating.ada}/${f.seating.tidak}; label lain ${c.lain}.`,
    );
  }
  const d = summary.decisions;
  console.log(`${dryRun ? "Akan ditulis" : "Ditulis"}: baru ${d.baru}, diperbarui ${d.diperbarui}. Tidak ditulis: sama ${d.sama}, tanpa atribut ${d.tanpa_atribut}, diperiksa tim atau bentuk tak dikenal ${d.dilindungi}, cara lain ${d.cara_lain}, lebih baru ${d.lebih_baru}.`);
  console.log(`${summary.withAksesBogorData} tempat yang cocok sudah punya lokasi AksesBogor dalam 50 m, jadi tidak tampil sebagai kandidat.`);
  console.log(dryRun ? "Dry run: tidak ada yang ditulis." : `Tersimpan: ${report.written} salinan di osm_places.`);
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
