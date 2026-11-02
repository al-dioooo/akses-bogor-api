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

const optional = <T extends z.ZodType>(type: T) => z.preprocess((value) => (value === "" ? undefined : value), type.optional());

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().default(8080),
    HOST: z.string().default("0.0.0.0"),
    /** PostgreSQL dengan PostGIS, dipakai aplikasi, migrasi, dan seed. */
    DATABASE_URL: z.url(),
    /** Origin web yang boleh memanggil API, dipisah koma. */
    FRONTEND_ORIGINS: csv(),
    /** Alamat publik bucket foto di Cloudflare R2. Kosong berarti URL foto di respons bernilai null. */
    PHOTO_PUBLIC_URL: optional(z.url()),
    /** Token rahasia Mapbox ber-scope tokens:write untuk membuat token peta sementara (ADR-0016). */
    MAPBOX_SECRET_TOKEN: optional(z.string().startsWith("sk.")),
    /** Username akun Mapbox pemilik token rahasia. */
    MAPBOX_USERNAME: optional(z.string().min(1)),
  })
  .refine((env) => !env.MAPBOX_SECRET_TOKEN === !env.MAPBOX_USERNAME, {
    message: "MAPBOX_SECRET_TOKEN dan MAPBOX_USERNAME harus diisi bersama",
    path: ["MAPBOX_USERNAME"],
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
