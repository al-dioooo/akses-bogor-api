import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { listTeam, revokeVerifier, setRoleByEmail } from "../admin/roles.js";
import type { Auth } from "../auth/auth.js";
import { requireAdmin } from "../auth/session.js";
import { HttpError, errorSchema } from "../http/errors.js";

export type AdminRouteOptions = { auth?: Auth; now: () => Date };

const TAG = "Admin";

const member = z
  .object({
    id: z.uuid(),
    displayName: z.string(),
    email: z.email().describe("Hanya terlihat oleh admin"),
    role: z.enum(["verifikator", "admin"]),
  })
  .describe("Anggota tim verifikasi");

/** Tim verifikator (FR-36, ADR-0035): admin memberi dan mencabut peran verifikator. Peran admin hanya lewat skrip. */
export const adminRoutes: FastifyPluginAsyncZod<AdminRouteOptions> = async (app, opts) => {
  const admin = (request: FastifyRequest) => {
    if (!opts.auth) throw new HttpError(503, "akun_belum_diatur", "Fitur akun belum diatur di server.");
    return requireAdmin(opts.auth, app.db, request, opts.now);
  };

  app.get(
    "/admin/team",
    {
      schema: {
        tags: [TAG],
        summary: "Tim verifikasi",
        description: "Verifikator dan admin, urut nama. Khusus admin. Tidak ada daftar atau pencarian pengguna lain (ADR-0035).",
        response: { 200: z.object({ items: z.array(member) }), 401: errorSchema, 403: errorSchema, 503: errorSchema },
      },
    },
    async (request, reply) => {
      await admin(request);
      reply.header("cache-control", "no-store");
      return { items: (await listTeam(app.db)) as z.infer<typeof member>[] };
    },
  );

  app.post(
    "/admin/team",
    {
      schema: {
        tags: [TAG],
        summary: "Jadikan verifikator",
        description:
          "Memberi peran verifikator ke akun dengan email yang tepat. Akun harus sudah ada dan sudah dilengkapi; bila tidak, 404 `akun_tidak_ditemukan` atau 409 `akun_belum_lengkap`. Admin tetap admin. Dicatat di log audit.",
        body: z.object({ email: z.email().max(254) }),
        response: { 200: member, 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema, 409: errorSchema, 503: errorSchema },
      },
    },
    async (request) => {
      const user = await admin(request);
      const { member: found } = await setRoleByEmail(app.db, request.body.email, "verifikator", { userId: user.id }, opts.now(), { keepAdmin: true });
      return found as z.infer<typeof member>;
    },
  );

  app.delete(
    "/admin/team/:userId",
    {
      schema: {
        tags: [TAG],
        summary: "Cabut peran verifikator",
        description: "Akun kembali menjadi pengguna biasa dan langsung tidak bisa membuka panel. Peran admin tidak bisa dicabut di sini (409 `admin_lewat_skrip`).",
        params: z.object({ userId: z.uuid() }),
        response: { 204: z.null(), 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema, 409: errorSchema, 503: errorSchema },
      },
    },
    async (request, reply) => {
      const user = await admin(request);
      await revokeVerifier(app.db, request.params.userId, { userId: user.id }, opts.now());
      return reply.code(204).send(null);
    },
  );
};
