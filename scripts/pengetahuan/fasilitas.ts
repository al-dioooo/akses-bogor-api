// Kampus, masjid, halte, dan rumah sakit di Kota Bogor dari OpenStreetMap, lewat satu kueri area Overpass, sebagai calon
// tujuan kontributor (ADR-0043). Hanya empat kategori MVP (ADR-0004).
//
//   pnpm pengetahuan:fasilitas             # unduh dari Overpass, simpan salinan mentah, lalu muat
//   pnpm pengetahuan:fasilitas --salinan   # muat dari salinan mentah terakhir tanpa mengunduh
import { FACILITIES_QUERY, loadFacilities, parseFacilities } from "../../src/contribute/facilities.js";
import { OVERPASS_URL } from "../../src/knowledge/osm.js";
import { obtain, withDb } from "./unduh.js";

await withDb(async (db) => {
  const raw = await obtain("osm-tempat-umum-kota-bogor.json", OVERPASS_URL, { method: "POST", body: new URLSearchParams({ data: FACILITIES_QUERY }), timeoutMs: 180_000 });
  const body = JSON.parse(raw.bytes.toString("utf8")) as Parameters<typeof parseFacilities>[0] & { remark?: string };
  if (body.remark) throw new Error(`Overpass: ${body.remark}`);
  const rows = parseFacilities(body);
  const stored = await loadFacilities(db, rows, raw);
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  const byCategory = [...counts].map(([category, n]) => `${category} ${n}`);
  console.log(`OpenStreetMap ${raw.retrievedAt.toISOString()}: ${stored} tempat di Kota Bogor tersimpan dari ${rows.length} (${byCategory.join(", ")}).`);
});
