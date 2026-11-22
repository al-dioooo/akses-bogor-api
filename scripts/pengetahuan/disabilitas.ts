// Jumlah penyandang disabilitas terdaftar per kecamatan dari Open Data Kota Bogor, satu permintaan ke API portal
// (ADR-0043). Syarat portal membatasi pemakaian untuk pihak ketiga, jadi datanya hanya dipakai saat
// DISABILITY_DATA_ENABLED menyala.
//
//   pnpm pengetahuan:disabilitas             # unduh, simpan salinan mentah, lalu muat
//   pnpm pengetahuan:disabilitas --salinan   # muat dari salinan mentah terakhir tanpa mengunduh
import { DISABILITY_SOURCE, loadDisabilityCounts, parseDisabilityCounts } from "../../src/contribute/disability.js";
import { districts } from "../../src/db/schema.js";
import { obtain, withDb } from "./unduh.js";

await withDb(async (db) => {
  const raw = await obtain("disabilitas-kota-bogor.json", DISABILITY_SOURCE.url);
  const slugs = (await db.select({ slug: districts.slug }).from(districts)).map((d) => d.slug);
  const rows = parseDisabilityCounts(JSON.parse(raw.bytes.toString("utf8")), slugs);
  const count = await loadDisabilityCounts(db, rows, raw);
  const years = [...new Set(rows.map((r) => r.year))].sort();
  const totals = years.map((y) => `${y}: ${rows.filter((r) => r.year === y).reduce((sum, r) => sum + r.count, 0)}`);
  console.log(`Data disabilitas ${raw.retrievedAt.toISOString()}: ${count} baris tersimpan (${totals.join(", ")}).`);
});
