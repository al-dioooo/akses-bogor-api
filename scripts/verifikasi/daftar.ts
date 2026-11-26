// Daftar semua data yang belum diperiksa, untuk dipilih dan diperiksa dengan Street View (ADR-0057). Hanya membaca,
// di dalam transaksi read-only. CSV ke stdout, jumlah per jenis ke stderr.
//
//   pnpm verifikasi:daftar > verifikasi-daftar.csv
//
// Laporan hanya ditulis id, jenis, dan status: tanpa pelapor, nama tempat, titik, atau isian teks.
import { loadEnv } from "../../src/config/env.js";
import { createDb } from "../../src/db/client.js";
import { LIST_KINDS, listUnverified, toCsv } from "../../src/hints/verification-list.js";

async function main() {
  const { db, pool } = createDb(loadEnv().DATABASE_URL);
  const { rows, counts } = await listUnverified(db).finally(() => pool.end());
  process.stdout.write(toCsv(rows));
  console.error(`${rows.length} baris:`);
  for (const kind of LIST_KINDS) {
    const statuses = [...counts].filter(([key]) => key.startsWith(`${kind}/`)).map(([key, n]) => `${key.slice(kind.length + 1)} ${n}`);
    console.error(`  ${kind}: ${counts.get(kind)}${statuses.length > 1 ? ` (${statuses.join(", ")})` : ""}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
