import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";

/** Berlaku untuk node-postgres (Neon) di produksi dan PGlite di tes. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export function createDb(connectionString: string, onPoolError?: (error: Error) => void) {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
  });
  // Neon closes idle connections and suspends compute when idle. Without this listener the pool
  // re-emits that as an unhandled 'error' event and the process exits. The pool drops the broken
  // client by itself and opens a new one on the next query.
  pool.on("error", (error) => onPoolError?.(error));
  const db: Db = drizzle(pool, { schema });
  return { db, pool };
}
