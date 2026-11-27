// Bagian yang sama untuk skrip `scripts/hak-subjek/*`: koneksi database dari environment, galat sebagai pesan pendek
// tanpa stack, dan pembacaan nomor permintaan. Skrip hanya mencetak id akun, nomor permintaan, dan jumlah.
import { loadEnv } from "../config/env.js";
import { createDb, type Db } from "../db/client.js";
import { HttpError } from "../http/errors.js";

/** Mencetak cara pakai lalu keluar dengan kode 2. */
export function usage(text: string): never {
  console.error(`Pakai:\n${text}`);
  process.exit(2);
}

/** Nomor permintaan dari baris perintah, bilangan bulat positif. */
export function requestNumber(value: string | undefined, text: string) {
  const id = Number(value);
  if (!value || !Number.isSafeInteger(id) || id < 1) usage(text);
  return id;
}

export async function runScript(main: (db: Db, now: Date) => Promise<void>) {
  const env = loadEnv();
  const { db, pool } = createDb(env.DATABASE_URL);
  try {
    await main(db, new Date());
  } catch (error) {
    console.error(error instanceof HttpError ? error.message : error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
