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
  /** Neon Postgres, koneksi pooled untuk aplikasi. */
  DATABASE_URL: z.url(),
  /** Koneksi langsung (unpooled) untuk migrasi Drizzle. */
  DATABASE_URL_UNPOOLED: z.url().optional(),
  /** Origin web yang boleh memanggil API, dipisah koma. */
  FRONTEND_ORIGINS: csv(),
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
