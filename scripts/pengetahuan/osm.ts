// Fitur aksesibilitas dan rute angkutan Kota Bogor dari OpenStreetMap, lewat satu kueri area Overpass (ADR-0042).
//
//   pnpm pengetahuan:osm             # unduh dari Overpass, simpan salinan mentah, lalu muat
//   pnpm pengetahuan:osm --salinan   # muat dari salinan mentah terakhir tanpa mengunduh
//
// Jalankan paling sering sekali sehari; untuk mencoba ulang pemuatan, pakai `--salinan`.
import { OVERPASS_QUERY, OVERPASS_URL, parseOverpass } from "../../src/knowledge/osm.js";
import { loadOsm } from "../../src/knowledge/osm-store.js";
import { obtain, withDb } from "./unduh.js";

await withDb(async (db) => {
  const raw = await obtain("osm-kota-bogor.json", OVERPASS_URL, { method: "POST", body: new URLSearchParams({ data: OVERPASS_QUERY }), timeoutMs: 240_000 });
  const body = JSON.parse(raw.bytes.toString("utf8")) as Parameters<typeof parseOverpass>[0] & { remark?: string };
  // Overpass bisa menjawab 200 dengan `remark` bila kuerinya kehabisan waktu; datanya tidak lengkap.
  if (body.remark) throw new Error(`Overpass: ${body.remark}`);
  const { features, routes } = await loadOsm(db, parseOverpass(body), raw);
  console.log(`OpenStreetMap ${raw.retrievedAt.toISOString()}: ${features} fitur dan ${routes} rute di Kota Bogor tersimpan.`);
});
