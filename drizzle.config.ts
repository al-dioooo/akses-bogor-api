import { defineConfig } from "drizzle-kit";

// drizzle-kit tidak membaca .env sendiri.
try {
  process.loadEnvFile();
} catch {
  // Tanpa .env, pakai environment yang sudah ada (mis. di CI).
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "" },
  // Tabel milik PostGIS (spatial_ref_sys) bukan bagian dari skema aplikasi.
  extensionsFilters: ["postgis"],
});
