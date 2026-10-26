// Mengisi database pengembangan dengan kecamatan dan lokasi contoh. Menolak berjalan di production.
import { loadEnv } from "../src/config/env.js";
import { createDb } from "../src/db/client.js";
import { seedSampleData } from "../src/db/seed.js";

const env = loadEnv();
if (env.NODE_ENV === "production") {
  console.error("db:seed menghapus data lokasi dan laporan, jadi tidak boleh dijalankan di production.");
  process.exit(1);
}
const { db, pool } = createDb(env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL);
const result = await seedSampleData(db);
await pool.end();
console.log(`Selesai: ${result.districts} kecamatan, ${result.places} lokasi contoh.`);
