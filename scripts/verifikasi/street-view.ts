// Menerapkan manifest verifikasi Street View ke database (ADR-0057). Satu transaksi, aman dijalankan ulang. Jalankan
// dulu dengan --dry-run dan periksa setiap baris. Langkah production ada di runbook docs
// `operations/verifikasi-street-view.md`.
//
//   pnpm verifikasi:street-view <manifest.json> --dry-run
//   pnpm verifikasi:street-view <manifest.json>
//
// --sembunyikan-kandidat juga menyembunyikan kandidat OSM yang tidak terjawab (mati bawaan; menunggu keputusan pemilik).
// Tabel `reports` tidak pernah ditulis.
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadEnv } from "../../src/config/env.js";
import { createDb } from "../../src/db/client.js";
import { hideUnsettled, runRecords, type Handler } from "../../src/hints/street-view-apply.js";
import { ManifestError, parseManifest } from "../../src/hints/street-view-manifest.js";
import { prepareImages, settle } from "../../src/hints/street-view-settle.js";
import { photoStoreFromEnv } from "../../src/photos/storage.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "dry-run": { type: "boolean", default: false },
    "sembunyikan-kandidat": { type: "boolean", default: false },
  },
});

async function main() {
  if (!positionals[0]) throw new Error("Sebutkan berkas manifest, mis. `pnpm verifikasi:street-view /srv/akses-bogor/data/street-view/<putaran>/manifest.json --dry-run`.");
  const path = resolve(positionals[0]);
  const manifest = parseManifest(JSON.parse(await readFile(path, "utf8")));
  const dryRun = values["dry-run"];

  // Gambar dibaca dan diproses sebelum transaksi, supaya berkas yang rusak tidak mengunci apa pun.
  const { images, problems } = await prepareImages(manifest, dirname(path));
  if (problems.length > 0) throw new ManifestError(problems);

  const env = loadEnv();
  const handler: Handler = (ctx, rec) => (rec.verdict === "settled" ? settle(ctx, rec, images) : hideUnsettled(ctx, rec));
  const { db, pool } = createDb(env.DATABASE_URL);
  const opts = { now: new Date(), dryRun, undo: false, hideCandidates: values["sembunyikan-kandidat"], store: photoStoreFromEnv(env), log: { warn: (obj: object, msg: string) => console.warn(msg, obj) } };
  const result = await runRecords(db, manifest, opts, handler).finally(() => pool.end());

  for (const line of result.lines) console.log(line);
  console.log("");
  console.log(`${dryRun ? "Dry run, tidak ada yang ditulis" : "Diterapkan"}: putaran ${manifest.round}, ${manifest.records.length} data.`);
  for (const [key, n] of [...result.counts].sort()) if (n > 0) console.log(`  ${key.replace(/_/g, " ")}: ${n}`);
  console.log("  laporan: tidak disentuh");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
