import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";

/** Berlaku untuk node-postgres di server dan PGlite di tes. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export function createDb(connectionString: string, onPoolError?: (error: Error) => void) {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
  });
  // Koneksi yang sedang menganggur bisa putus, mis. saat PostgreSQL di-restart. Tanpa listener ini
  // pool meneruskannya sebagai event 'error' yang tidak ditangani dan proses berhenti. Pool membuang
  // klien yang rusak dan membuka klien baru pada query berikutnya.
  pool.on("error", (error) => onPoolError?.(error));
  const db: Db = drizzle(pool, { schema });
  return { db, pool };
}
