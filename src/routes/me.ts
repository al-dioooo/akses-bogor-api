import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Auth } from "../auth/auth.js";
import { deleteAccount } from "../auth/delete-account.js";
import { PRIVACY_POLICY_VERSION } from "../auth/rules.js";
import { needsCompletion, requireSession, toUser, userSchema } from "../auth/session.js";
import { users } from "../db/schema.js";
import { accountDeletedEmail, type Mailer } from "../email/mailer.js";
import { HttpError, errorSchema } from "../http/errors.js";
import { listMyReports, myReports } from "../reports/mine.js";

export type MeRouteOptions = { auth?: Auth; mailer?: Mailer; now: () => Date };

const TAG = "Akun";

/** Nama tampilan 1 sampai 60 karakter tanpa karakter kontrol (FR-12). */
const displayName = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[^\p{C}]+$/u)
  .describe("Nama tampilan, 1 sampai 60 karakter. Dilihat verifikator, tidak tampil untuk publik");

const completeBody = z.object({
  displayName,
  acceptPrivacyPolicy: z.literal(true).describe("Harus benar: pengguna mencentang persetujuan Kebijakan Privasi (FR-11)"),
  privacyPolicyVersion: z.string().max(20).describe("Versi Kebijakan Privasi yang ditampilkan kepada pengguna"),
});

/** Route untuk akun yang sedang masuk. Server web mengirim token sesi sebagai `Authorization: Bearer` (ADR-0029). */
export const meRoutes: FastifyPluginAsyncZod<MeRouteOptions> = async (app, opts) => {
  const session = async (request: FastifyRequest) => {
    if (!opts.auth) throw new HttpError(503, "akun_belum_diatur", "Fitur akun belum diatur di server.");
    return requireSession(opts.auth, app.db, request, opts.now);
  };

  const updateUser = async (id: string, values: Partial<typeof users.$inferInsert>) => {
    const [row] = await app.db
      .update(users)
      .set({ ...values, updatedAt: opts.now() })
      .where(eq(users.id, id))
      .returning();
    return toUser({ ...row!, name: row!.displayName });
  };

  app.get(
    "/me",
    {
      schema: {
        tags: [TAG],
        summary: "Akun yang sedang masuk",
        description: "Nama tampilan, email, dan peran (FR-12). `needsCompletion` benar berarti web mengarahkan ke Lengkapi Akun.",
        response: { 200: userSchema, 401: errorSchema, 503: errorSchema },
      },
    },
    async (request, reply) => {
      const { user } = await session(request);
      reply.header("cache-control", "no-store");
      return toUser(user);
    },
  );

  app.post(
    "/me/complete",
    {
      schema: {
        tags: [TAG],
        summary: "Lengkapi akun",
        description: `Menyimpan nama tampilan dan persetujuan Kebijakan Privasi beserta waktu dan versinya (FR-11, FR-12). Versi saat ini: ${PRIVACY_POLICY_VERSION}. Versi lain menjawab 409 \`versi_kebijakan_berbeda\`.`,
        body: completeBody,
        response: { 200: userSchema, 400: errorSchema, 401: errorSchema, 409: errorSchema, 503: errorSchema },
      },
    },
    async (request) => {
      const { user } = await session(request);
      if (request.body.privacyPolicyVersion !== PRIVACY_POLICY_VERSION) {
        throw new HttpError(409, "versi_kebijakan_berbeda", "Kebijakan Privasi baru saja diperbarui. Muat ulang halaman, baca versi terbaru, lalu setujui lagi.");
      }
      return updateUser(user.id, {
        displayName: request.body.displayName,
        privacyConsentAt: opts.now(),
        privacyPolicyVersion: PRIVACY_POLICY_VERSION,
      });
    },
  );

  app.patch(
    "/me",
    {
      schema: {
        tags: [TAG],
        summary: "Ubah nama tampilan",
        description: "Email tidak bisa diubah di MVP (ADR-0029). Akun harus sudah dilengkapi.",
        body: z.object({ displayName }),
        response: { 200: userSchema, 400: errorSchema, 401: errorSchema, 403: errorSchema, 503: errorSchema },
      },
    },
    async (request) => {
      const { user } = await session(request);
      if (needsCompletion(user)) throw new HttpError(403, "akun_belum_lengkap", "Lengkapi akun dulu sebelum mengubah nama.");
      return updateUser(user.id, { displayName: request.body.displayName });
    },
  );

  app.get(
    "/me/reports",
    {
      schema: {
        tags: [TAG],
        summary: "Laporan saya",
        description: "Laporan milik akun ini dengan statusnya, alasan penolakan, dan pertanyaan klarifikasi, terbaru dulu (FR-14).",
        response: { 200: myReports, 401: errorSchema, 503: errorSchema },
      },
    },
    async (request, reply) => {
      const { user } = await session(request);
      reply.header("cache-control", "no-store");
      return listMyReports(app.db, user.id);
    },
  );

  app.delete(
    "/me",
    {
      schema: {
        tags: [TAG],
        summary: "Hapus akun",
        description:
          "Langsung menghapus akun, semua sesi, dan laporan yang belum terbit beserta fotonya (FR-13, ADR-0024). Laporan terbit tetap tayang tanpa pelapor. Email konfirmasi dikirim ke alamat lama; galat pengiriman tidak membatalkan penghapusan.",
        response: { 204: z.null().describe("Akun dihapus"), 401: errorSchema, 503: errorSchema },
      },
    },
    async (request, reply) => {
      const { user } = await session(request);
      const deleted = await deleteAccount(app.db, user.id);
      // Alamat email hanya ada di memori untuk email terakhir ini; di database sudah terhapus.
      if (deleted && opts.mailer) {
        try {
          await opts.mailer(accountDeletedEmail(deleted.email));
        } catch (error) {
          request.log.warn({ err: error }, "email konfirmasi akun dihapus gagal dikirim");
        }
      }
      return reply.code(204).send(null);
    },
  );
};
