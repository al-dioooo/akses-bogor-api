import { z } from "zod";

const csv = (fallback = "") =>
  z
    .string()
    .default(fallback)
    .transform((value) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    );

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default("0.0.0.0"),
  /** PostgreSQL dengan PostGIS, dipakai aplikasi, migrasi, dan seed. */
  DATABASE_URL: z.url(),
  /** Origin web yang boleh memanggil API, dipisah koma. */
  FRONTEND_ORIGINS: csv(),
  /** Alamat publik bucket foto di Cloudflare R2. Kosong berarti URL foto di respons bernilai null. */
  PHOTO_PUBLIC_URL: z.preprocess((value) => (value === "" ? undefined : value), z.url().optional()),
  /** Rahasia bersama dengan server Next.js, minimal 32 karakter. Kosong berarti header IP pengunjung diabaikan. */
  WEB_SERVER_SECRET: z.preprocess((value) => (value === "" ? undefined : value), z.string().min(32).optional()),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Konfigurasi environment tidak valid: ${fields}`);
  }
  return parsed.data;
}
