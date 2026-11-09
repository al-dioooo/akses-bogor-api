import { desc, eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { isAPIError } from "better-auth/api";
import { z } from "zod";
import type { Auth } from "../auth/auth.js";
import { CODE_ATTEMPTS, CODE_RESEND_SECONDS, CODE_TTL_MINUTES, CODES_PER_EMAIL_PER_HOUR } from "../auth/rules.js";
import { currentSession, sessionDeadline, toUser, userSchema } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { verifications } from "../db/schema.js";
import { codeEmail, type Mailer } from "../email/mailer.js";
import { HttpError, errorSchema } from "../http/errors.js";

export type AuthRouteOptions = {
  /** Kosong bila `BETTER_AUTH_SECRET` belum diatur di production. */
  auth?: Auth;
  /** Resend, atau log di development. Kosong berarti kode tidak bisa diminta (503). */
  mailer?: Mailer;
  googleEnabled: boolean;
  now: () => Date;
};

const TAG = "Akun";
const FIFTEEN_MINUTES = 15 * 60 * 1000;

const email = z.string().trim().toLowerCase().pipe(z.email().max(254)).describe("Alamat email");
const codeRequest = z.object({ email });
const codeCheck = z.object({ email, code: z.string().regex(/^\d{6}$/).describe("Kode 6 digit dari email") });
const googleSignIn = z.object({ idToken: z.string().min(20).max(4096).describe("ID token (credential) dari Google Identity Services") });

const codeSent = z
  .object({
    resendAfterSeconds: z.number().int().describe("Kode baru untuk email ini bisa diminta setelah sekian detik"),
    expiresInSeconds: z.number().int().describe("Masa berlaku kode"),
  })
  .describe("Kode terkirim");

const signedIn = z
  .object({
    token: z.string().describe("Token sesi bertanda tangan. Disimpan server web di cookie HttpOnly, dikirim balik sebagai Bearer"),
    expiresAt: z.iso.datetime().describe("Batas paling lama sesi (90 hari); sesi berakhir lebih cepat bila tidak dipakai 30 hari"),
    user: userSchema,
  })
  .describe("Berhasil masuk");

/** Kode email sudah terkirim; berapa lama sampai bisa minta lagi dalam detik, dibulatkan ke atas. */
const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

function tooManyRequests(reply: FastifyReply, ttlMs: number, message: (seconds: number) => string) {
  const wait = seconds(ttlMs);
  reply.header("retry-after", wait);
  return new HttpError(429, "kode_terlalu_sering", message(wait));
}

// Better Auth menyimpan kode email dengan identifier `sign-in-otp-<email>` dan nilai `<hash>:<percobaan>`.
const codeIdentifier = (address: string) => `sign-in-otp-${address}`;

/**
 * Better Auth baru melapor "terlalu banyak percobaan" pada percobaan keenam. Di sini sisa percobaan dihitung dari baris
 * kode, supaya percobaan salah kelima langsung memberi tahu bahwa kodenya gugur.
 */
async function wrongCode(db: Db, address: string) {
  // Better Auth hanya memakai kode terbaru untuk email itu.
  const [row] = await db
    .select({ value: verifications.value })
    .from(verifications)
    .where(eq(verifications.identifier, codeIdentifier(address)))
    .orderBy(desc(verifications.createdAt))
    .limit(1);
  if (!row) return new HttpError(400, "kode_tidak_berlaku", "Kode ini tidak berlaku lagi. Minta kode baru.");
  const remaining = CODE_ATTEMPTS - Number(row.value.slice(row.value.lastIndexOf(":") + 1));
  if (remaining <= 0) {
    await db.delete(verifications).where(eq(verifications.identifier, codeIdentifier(address)));
    return lockedCode();
  }
  return new HttpError(400, "kode_salah", `Kode salah. Sisa ${remaining} kali percobaan.`);
}

const lockedCode = () =>
  new HttpError(400, "kode_terkunci", `Kode salah ${CODE_ATTEMPTS} kali, jadi kode ini tidak bisa dipakai lagi. Minta kode baru.`);

/** Galat Better Auth menjadi `{ galat, pesan }`; galat lain diteruskan ke error handler (500). */
function authError(error: unknown) {
  if (!isAPIError(error)) return error;
  switch (error.body?.code) {
    case "OTP_EXPIRED":
      return new HttpError(400, "kode_kedaluwarsa", `Kode sudah lewat ${CODE_TTL_MINUTES} menit. Minta kode baru.`);
    case "TOO_MANY_ATTEMPTS":
      return lockedCode();
    case "INVALID_TOKEN":
      return new HttpError(401, "google_tidak_valid", "Masuk dengan Google gagal. Coba lagi, atau masuk dengan kode email.");
    case "EMAIL_NOT_VERIFIED":
      return unverifiedGoogleEmail();
    default:
      return error;
  }
}

const unverifiedGoogleEmail = () =>
  new HttpError(403, "email_google_belum_terverifikasi", "Email akun Google ini belum terverifikasi. Masuk dengan kode email.");

/**
 * Better Auth menerima ID token Google dengan `email_verified: false` dan bisa menggabungkannya ke akun lain. ADR-0029
 * hanya menerima email terverifikasi, jadi klaimnya dibaca dulu di sini. Tanda tangannya diperiksa Better Auth
 * sesudahnya, sehingga token palsu tetap ditolak.
 */
function googleEmailVerified(idToken: string) {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as { email_verified?: unknown };
    return payload.email_verified === true;
  } catch {
    return false;
  }
}

export const authRoutes: FastifyPluginAsyncZod<AuthRouteOptions> = async (app, opts) => {
  const ready = () => {
    if (!opts.auth) throw new HttpError(503, "akun_belum_diatur", "Fitur akun belum diatur di server.");
    return opts.auth;
  };

  // Batas per email (ADR-0029). Satu permintaan hanya menjalankan satu hook rate limit, jadi batas per email dihitung
  // di dalam handler dengan store yang sama, setelah batas per klien di config route.
  const perEmailPause = app.createRateLimit({
    max: 1,
    timeWindow: CODE_RESEND_SECONDS * 1000,
    keyGenerator: (request) => `kode-jeda:${(request.body as { email: string }).email}`,
  });
  const perEmailHour = app.createRateLimit({
    max: CODES_PER_EMAIL_PER_HOUR,
    timeWindow: 60 * 60 * 1000,
    keyGenerator: (request) => `kode-jam:${(request.body as { email: string }).email}`,
  });

  /** Batas per klien, dihitung dengan kunci rate limit global (IP pengunjung bila dikirim server web). */
  const perClient = (max: number, what: string) => ({
    max,
    timeWindow: FIFTEEN_MINUTES,
    errorResponseBuilder: (_request: FastifyRequest, context: { ttl: number }) =>
      new HttpError(429, "terlalu_sering", `Terlalu banyak ${what} dari jaringan ini. Coba lagi dalam ${Math.ceil(context.ttl / 60_000)} menit.`),
  });

  /** Hasil masuk Better Auth menjadi respons route: token bertanda tangan dari plugin bearer. */
  async function signedInResponse(result: { headers: Headers; response: object }) {
    const token = result.headers.get("set-auth-token");
    if (!token || !("user" in result.response)) throw new Error("Better Auth tidak mengembalikan sesi");
    return { token, expiresAt: sessionDeadline(opts.now()).toISOString(), user: toUser(result.response.user as Parameters<typeof toUser>[0]) };
  }

  app.post(
    "/auth/code",
    {
      config: { rateLimit: perClient(10, "permintaan kode") },
      schema: {
        tags: [TAG],
        summary: "Kirim kode masuk",
        description: `Mengirim kode 6 digit ke email (FR-10, ADR-0014). Sama untuk email baru dan yang sudah terdaftar. Kode baru untuk email yang sama bisa diminta setelah ${CODE_RESEND_SECONDS} detik, paling banyak ${CODES_PER_EMAIL_PER_HOUR} per jam; per klien 10 permintaan per 15 menit.`,
        body: codeRequest,
        response: { 200: codeSent, 400: errorSchema, 429: errorSchema, 502: errorSchema, 503: errorSchema },
      },
    },
    async (request, reply) => {
      const auth = ready();
      const { mailer } = opts;
      if (!mailer) throw new HttpError(503, "email_belum_diatur", "Kode email belum bisa dikirim. Masuk dengan Google, atau coba lagi nanti.");

      const pause = await perEmailPause(request);
      if (!pause.isAllowed && pause.isExceeded) throw tooManyRequests(reply, pause.ttl, (wait) => `Tunggu ${wait} detik sebelum meminta kode baru.`);
      const hour = await perEmailHour(request);
      if (!hour.isAllowed && hour.isExceeded) {
        throw tooManyRequests(reply, hour.ttl, (wait) => `Sudah ${CODES_PER_EMAIL_PER_HOUR} kode diminta untuk email ini. Coba lagi dalam ${Math.ceil(wait / 60)} menit.`);
      }

      // Kode lama untuk email ini dibatalkan; Better Auth menyimpan kode baru sebagai HMAC dan mengembalikan kodenya.
      const address = request.body.email;
      await app.db.delete(verifications).where(eq(verifications.identifier, codeIdentifier(address)));
      const code = await auth.api.createVerificationOTP({ body: { email: address, type: "sign-in" } });
      try {
        await mailer(codeEmail(address, code));
      } catch (error) {
        request.log.warn({ err: error }, "email kode gagal dikirim");
        throw new HttpError(502, "email_gagal_dikirim", "Kode belum bisa dikirim. Coba lagi sebentar lagi.");
      }
      return { resendAfterSeconds: CODE_RESEND_SECONDS, expiresInSeconds: CODE_TTL_MINUTES * 60 };
    },
  );

  app.post(
    "/auth/code/verify",
    {
      config: { rateLimit: perClient(30, "percobaan kode") },
      schema: {
        tags: [TAG],
        summary: "Masuk dengan kode",
        description: `Mencocokkan kode dan membuat sesi. Akun dibuat bila email belum terdaftar (ADR-0029). Kode gugur setelah ${CODE_ATTEMPTS} kali salah atau ${CODE_TTL_MINUTES} menit. Galat: \`kode_salah\` (dengan sisa percobaan), \`kode_terkunci\`, \`kode_kedaluwarsa\`, \`kode_tidak_berlaku\`.`,
        body: codeCheck,
        response: { 200: signedIn, 400: errorSchema, 429: errorSchema, 503: errorSchema },
      },
    },
    async (request) => {
      const auth = ready();
      const { email: address, code } = request.body;
      try {
        return await signedInResponse(await auth.api.signInEmailOTP({ body: { email: address, otp: code }, returnHeaders: true }));
      } catch (error) {
        if (isAPIError(error) && error.body?.code === "INVALID_OTP") throw await wrongCode(app.db, address);
        throw authError(error);
      }
    },
  );

  app.post(
    "/auth/google",
    {
      config: { rateLimit: perClient(30, "percobaan masuk") },
      schema: {
        tags: [TAG],
        summary: "Masuk dengan Google",
        description:
          "Memeriksa ID token dari tombol Google Identity Services terhadap client ID AksesBogor dan membuat sesi. Email harus terverifikasi di Google. Akun dengan email yang sama dipakai bersama login kode email (ADR-0014).",
        body: googleSignIn,
        response: { 200: signedIn, 401: errorSchema, 403: errorSchema, 429: errorSchema, 503: errorSchema },
      },
    },
    async (request) => {
      const auth = ready();
      if (!opts.googleEnabled) throw new HttpError(503, "google_belum_diatur", "Masuk dengan Google belum diatur. Masuk dengan kode email.");
      if (!googleEmailVerified(request.body.idToken)) throw unverifiedGoogleEmail();
      try {
        return await signedInResponse(
          await auth.api.signInSocial({ body: { provider: "google", idToken: { token: request.body.idToken } }, returnHeaders: true }),
        );
      } catch (error) {
        throw authError(error);
      }
    },
  );

  app.post(
    "/auth/logout",
    {
      schema: {
        tags: [TAG],
        summary: "Keluar",
        description: "Mencabut sesi dari header Authorization. Tetap 204 bila sesinya sudah tidak berlaku.",
        response: { 204: z.null().describe("Sesi dicabut"), 503: errorSchema },
      },
    },
    async (request, reply) => {
      const auth = ready();
      if (await currentSession(auth, app.db, request, opts.now)) {
        await auth.api.signOut({ headers: new Headers({ authorization: request.headers.authorization! }) });
      }
      return reply.code(204).send(null);
    },
  );
};
