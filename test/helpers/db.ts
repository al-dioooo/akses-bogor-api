// Postgres + PostGIS di dalam proses lewat PGlite, dengan migrasi yang sama seperti produksi.
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { postgis } from "@electric-sql/pglite-postgis";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "../../src/db/client.js";
import * as schema from "../../src/db/schema.js";

export async function createTestDb() {
  const client = await PGlite.create({ extensions: { postgis, pg_trgm } });
  const pglite = drizzle(client, { schema });
  await migrate(pglite, { migrationsFolder: "drizzle" });
  return { db: pglite as unknown as Db, client, close: () => client.close() };
}
