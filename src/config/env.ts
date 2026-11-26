import { z } from "zod";
import { DEFAULT_ASSISTANT_QUESTIONS_PER_DAY, DEFAULT_REQUESTS_PER_DAY } from "../agent/limits.js";

/** Batas pencarian petunjuk aksesibilitas per penyedia per hari WIB, bila env tidak mengaturnya (ADR-0052). */
export const DEFAULT_HINTS_PER_DAY = 1000;

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
/** Nilai kosong di file env, mis. `AGENT_REQUESTS_PER_DAY=`, berarti bawaan. */
const orDefault = <T extends z.ZodType>(type: T) => z.preprocess((value) => (value === "" ? undefined : value), type);

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
    /** Alamat publik API, mis. https://akses-bogor-api.aldio.dev. */
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
    /**
     * Route agen rute `/agent/*` dan rute jalan kaki `/route/*` (ADR-0042). Mati sampai syarat peluncurannya terpenuhi,
     * termasuk Kebijakan Privasi yang menyebut Mapbox Directions dan penyedia model.
     */
    ROUTE_AGENT_ENABLED: z.stringbool().default(false),
    /**
     * Data penyandang disabilitas terdaftar dari Open Data Kota Bogor untuk prioritas kecamatan (ADR-0043). Mati sampai
     * Diskominfo Kota Bogor mengizinkan pemakaiannya, karena syarat portal membatasi pemakaian untuk pihak ketiga.
     */
    DISABILITY_DATA_ENABLED: z.stringbool().default(false),
    /**
     * Asisten rute publik `/route-assistant/*` untuk siapa pun, juga tanpa akun (ADR-0050), dan rute jalan kaki ke lokasi
     * AksesBogor tanpa akun. Mati sampai Kebijakan Privasi yang menyebut asisten ini dirilis.
     */
    ROUTE_ASSISTANT_ENABLED: z.stringbool().default(false),
    /**
     * Petunjuk aksesibilitas langsung dari Mapbox dan Google di Detail lokasi dan kartu Peta (ADR-0052). Mati bawaan:
     * setiap petunjuk berarti panggilan berbayar ke penyedia. Mapbox memakai `MAPBOX_SECRET_TOKEN`.
     */
    PROVIDER_HINTS_ENABLED: z.stringbool().default(false),
    /** API key Google Maps Platform untuk Places API (New), hanya untuk petunjuk aksesibilitas. Kosong berarti Google mati. */
    GOOGLE_MAPS_API_KEY: optional(z.string().min(1)),
    /** Batas pencarian petunjuk Mapbox per hari WIB, di memori proses. Bawaan 1000. */
    PROVIDER_HINTS_MAPBOX_PER_DAY: orDefault(z.coerce.number().int().min(1).default(DEFAULT_HINTS_PER_DAY)),
    /** Batas pencarian petunjuk Google per hari WIB, di memori proses. Bawaan 1000. */
    PROVIDER_HINTS_GOOGLE_PER_DAY: orDefault(z.coerce.number().int().min(1).default(DEFAULT_HINTS_PER_DAY)),
    /** Pertanyaan asisten rute publik per hari WIB untuk semua penanya. Bawaan 300; satu pertanyaan paling banyak 4 permintaan ke model. */
    ROUTE_ASSISTANT_QUESTIONS_PER_DAY: orDefault(z.coerce.number().int().min(1).default(DEFAULT_ASSISTANT_QUESTIONS_PER_DAY)),
    /**
     * Penyedia model agen (ADR-0047): `anthropic` untuk Claude API, atau `openrouter`. Tidak ada cadangan otomatis ke
     * penyedia lain; pertanyaan hanya dikirim ke penyedia yang dipilih di sini.
     */
    AGENT_PROVIDER: orDefault(z.enum(["anthropic", "openrouter"]).default("anthropic")),
    /** Permintaan ke model yang berhasil per hari UTC untuk semua pengguna. Bawaan 45. */
    AGENT_REQUESTS_PER_DAY: orDefault(z.coerce.number().int().min(1).default(DEFAULT_REQUESTS_PER_DAY)),
    /** API key Claude API untuk model agen (ADR-0047). Kosong berarti agen menjawab sibuk; API tetap jalan. */
    ANTHROPIC_API_KEY: optional(z.string().startsWith("sk-ant-")),
    /** Model Claude untuk agen. Kosong berarti `claude-haiku-5-5`. */
    ANTHROPIC_MODEL: optional(z.string().trim().min(1)),
    /** Effort Claude (`output_config.effort`): `low`, `medium`, atau `high`. Kosong berarti `low` (ADR-0047). */
    ANTHROPIC_EFFORT: optional(z.enum(["low", "medium", "high"])),
    /** API key OpenRouter bila `AGENT_PROVIDER=openrouter` (ADR-0042). Kosong berarti agen menjawab sibuk; API tetap jalan. */
    OPENROUTER_API_KEY: optional(z.string().startsWith("sk-or-")),
    /** Model OpenRouter berurutan, dipisah koma; yang pertama dicoba dulu. Kosong berarti daftar bawaan API. */
    OPENROUTER_MODELS: csv(),
    /**
     * Alamat Valhalla di host yang sama, mis. http://127.0.0.1:8002, untuk rute pejalan kaki dari data OpenStreetMap
     * dengan profil kursi roda atau jalan kaki (ADR-0055). Kosong berarti fitur ini mati dan kartu rute tetap memakai
     * rute jalan kaki Mapbox.
     */
    ACCESSIBLE_ROUTER_URL: optional(z.url()),
    /** Ringkasan tag jalur dari pembangunan ubin, mis. /srv/valhalla/aktif/jalur.json. Kosong berarti cakupan data tidak dihitung. */
    ACCESSIBLE_ROUTER_WAYS_FILE: optional(z.string().min(1)),
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
