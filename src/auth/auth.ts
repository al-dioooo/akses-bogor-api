import { createHmac } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, emailOTP } from "better-auth/plugins";
import type { Db } from "../db/client.js";
import { accounts, sessions, users, verifications } from "../db/schema.js";
import { codeEmail, type Mailer } from "../email/mailer.js";
import { CODE_ATTEMPTS, CODE_TTL_MINUTES, SESSION_IDLE_DAYS } from "./rules.js";

const DAY = 24 * 60 * 60;

const NO_PROVIDER_TOKENS = {
  accessToken: null,
  refreshToken: null,
  idToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
  scope: null,
};

export type AuthOptions = {
  db: Db;
  /** Minimal 32 karakter. Menandatangani token sesi dan menjadi kunci HMAC kode email. */
  secret: string;
  /** Alamat publik API. */
  baseURL: string;
  googleClientId?: string;
  /** Kosong berarti kode email tidak bisa diminta (503 di route). */
  mailer?: Mailer;
};

/**
 * Better Auth untuk akun AksesBogor (ADR-0029). Route bawaannya tidak dibuka; route Fastify di `routes/auth.ts`
 * memanggil `auth.api.*`. Rate limiter bawaan dimatikan karena batasnya diatur `@fastify/rate-limit`.
 */
export function createAuth({ db, secret, baseURL, googleClientId, mailer }: AuthOptions) {
  // Kode 6 digit mudah ditebak dari SHA-256 biasa, jadi hash-nya memakai kunci rahasia.
  const hashCode = async (code: string) => createHmac("sha256", secret).update(code).digest("base64url");

  return betterAuth({
    appName: "AksesBogor",
    baseURL,
    basePath: "/auth",
    secret,
    telemetry: { enabled: false },
    rateLimit: { enabled: false },
    database: drizzleAdapter(db, { provider: "pg", schema: { users, sessions, accounts, verifications } }),
    user: {
      modelName: "users",
      fields: { name: "displayName" },
      additionalFields: {
        role: { type: "string", input: false, defaultValue: "pengguna" },
        privacyConsentAt: { type: "date", input: false, required: false },
        privacyPolicyVersion: { type: "string", input: false, required: false },
      },
    },
    session: {
      modelName: "sessions",
      expiresIn: SESSION_IDLE_DAYS * DAY,
      updateAge: DAY,
    },
    account: {
      modelName: "accounts",
      // Login Google dan kode email dengan email yang sama masuk ke akun yang sama (ADR-0014).
      accountLinking: { enabled: true, trustedProviders: ["google", "email-otp"] },
      updateAccountOnSignIn: false,
    },
    verification: { modelName: "verifications" },
    databaseHooks: {
      // Data minimal (ADR-0029): sesi tanpa alamat IP dan user agent, dan token Google tidak dibutuhkan lagi setelah
      // ID token diperiksa.
      session: {
        create: { before: async (session) => ({ data: { ...session, ipAddress: null, userAgent: null } }) },
      },
      account: {
        create: { before: async (account) => ({ data: { ...account, ...NO_PROVIDER_TOKENS } }) },
        update: { before: async (account) => ({ data: { ...account, ...NO_PROVIDER_TOKENS } }) },
      },
    },
    advanced: {
      database: { generateId: "uuid" },
      ipAddress: { disableIpTracking: true },
    },
    socialProviders: googleClientId
      ? {
          google: {
            clientId: googleClientId,
            // Hanya ID token dari Google Identity Services yang dipakai, jadi client secret tidak dibutuhkan.
            clientSecret: "",
            // Nama dari Google hanya usulan untuk Lengkapi Akun; foto profil tidak disimpan.
            mapProfileToUser: (profile) => ({ name: (profile.name ?? "").slice(0, 60), image: undefined }),
          },
        }
      : {},
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: CODE_TTL_MINUTES * 60,
        allowedAttempts: CODE_ATTEMPTS,
        storeOTP: { hash: hashCode },
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== "sign-in") return;
          if (!mailer) throw new Error("pengirim email belum diatur");
          await mailer(codeEmail(email, otp));
        },
      }),
      bearer({ requireSignature: true }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
