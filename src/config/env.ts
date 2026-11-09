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

const R2_KEYS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_LAPORAN", "R2_BUCKET_PUBLIK"] as const;

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().default(8080),
    HOST: z.string().default("0.0.0.0"),
    /** PostgreSQL dengan PostGIS, dipakai aplikasi, migrasi, dan seed. */
    DATABASE_URL: z.url(),
    /** Origin web yang boleh memanggil API, dipisah koma. Origin pertama menjadi alamat tautan di email status laporan. */
    FRONTEND_ORIGINS: csv(),
    /** Alamat publik bucket foto di Cloudflare R2. Kosong berarti URL foto di respons bernilai null. */
    PHOTO_PUBLIC_URL: optional(z.url()),
    /** Token rahasia Mapbox ber-scope tokens:write untuk membuat token peta sementara (ADR-0016). */
    MAPBOX_SECRET_TOKEN: optional(z.string().startsWith("sk.")),
    /** Username akun Mapbox pemilik token rahasia. */
    MAPBOX_USERNAME: optional(z.string().min(1)),
    /**
     * Rahasia Better Auth (ADR-0029): tanda tangan token sesi dan kunci HMAC kode email. Kosong di production berarti
     * route akun menjawab 503; di development dipakai rahasia tetap khusus lokal.
     */
    BETTER_AUTH_SECRET: optional(z.string().min(32)),
    /** Alamat publik API, mis. https://akses-bogor-api.yorhagarden.xyz. */
    BETTER_AUTH_URL: optional(z.url()),
    /** Client ID OAuth Google untuk memeriksa ID token. Kosong berarti masuk dengan Google mati. */
    GOOGLE_CLIENT_ID: optional(z.string().min(1)),
    /** API key Resend (ADR-0030). Kosong di luar production berarti kode email dicetak ke log. */
    RESEND_API_KEY: optional(z.string().startsWith("re_")),
    /** Pengirim email pada domain yang sudah diverifikasi di Resend, mis. "AksesBogor <masuk@kirim.contoh.id>". */
    EMAIL_FROM: optional(z.string().min(3)),
    /** ID akun Cloudflare untuk endpoint R2 (ADR-0031). Kelima variabel R2 diisi bersama. */
    R2_ACCOUNT_ID: optional(z.string().regex(/^[a-f0-9]{32}$/)),
    /** Access key token R2 ber-izin Object Read & Write untuk dua bucket foto saja. */
    R2_ACCESS_KEY_ID: optional(z.string().min(1)),
    R2_SECRET_ACCESS_KEY: optional(z.string().min(1)),
    /** Bucket privat untuk foto laporan yang belum terbit. */
    R2_BUCKET_LAPORAN: optional(z.string().min(3)),
    /** Bucket publik di balik PHOTO_PUBLIC_URL untuk foto yang sudah terbit. */
    R2_BUCKET_PUBLIK: optional(z.string().min(3)),
    /** Folder foto di development tanpa R2. Bawaan `.data/foto`. */
    PHOTO_STORAGE_DIR: optional(z.string().min(1)),
    /** Rahasia bersama dengan server Next.js, minimal 32 karakter. Kosong berarti header IP pengunjung diabaikan. */
    WEB_SERVER_SECRET: optional(z.string().min(32)),
  })
  .refine((env) => !env.MAPBOX_SECRET_TOKEN === !env.MAPBOX_USERNAME, {
    message: "MAPBOX_SECRET_TOKEN dan MAPBOX_USERNAME harus diisi bersama",
    path: ["MAPBOX_USERNAME"],
  })
  .refine((env) => !env.RESEND_API_KEY === !env.EMAIL_FROM, {
    message: "RESEND_API_KEY dan EMAIL_FROM harus diisi bersama",
    path: ["EMAIL_FROM"],
  })
  .refine((env) => new Set(R2_KEYS.map((key) => !env[key])).size === 1, {
    message: "Kelima variabel R2 harus diisi bersama",
    path: ["R2_ACCOUNT_ID"],
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
