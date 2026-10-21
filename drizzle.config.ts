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
});
