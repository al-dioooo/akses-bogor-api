import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { Auth } from "../auth/auth.js";
import { requireVerifier } from "../auth/session.js";
import { HttpError, errorSchema } from "../http/errors.js";
import { getReview, listQueue, listRecheck } from "../verification/queue.js";
import { queue, queueQuery, recheckList, review, reportIdParams } from "../verification/schemas.js";

export type VerifierRouteOptions = {
  auth?: Auth;
  /** Alamat publik bucket foto, untuk foto lokasi yang sudah tayang. */
  photoBaseUrl?: string;
  now: () => Date;
};

const TAG = "Verifikasi";

/**
 * Panel verifikator (FR-30 sampai FR-38, ADR-0035). Setiap route memeriksa sesi dan peran verifikator atau admin,
 * dan tidak pernah mengembalikan laporan milik verifikator itu sendiri (FR-37).
 */
export const verifierRoutes: FastifyPluginAsyncZod<VerifierRouteOptions> = async (app, opts) => {
  const verifier = (request: FastifyRequest) => {
    if (!opts.auth) throw new HttpError(503, "akun_belum_diatur", "Fitur akun belum diatur di server.");
    return requireVerifier(opts.auth, app.db, request, opts.now);
  };
  const guarded = { 401: errorSchema, 403: errorSchema, 503: errorSchema };

  app.get(
    "/verifier/reports",
    {
      schema: {
        tags: [TAG],
        summary: "Antrean verifikasi",
        description:
          "Laporan baru, perubahan, dan kekurangan, terlama dulu (FR-30). `status=klarifikasi` berisi laporan yang menunggu jawaban pelapor. Laporan milik verifikator itu sendiri tidak ikut (FR-37).",
        querystring: queueQuery,
        response: { 200: queue, 400: errorSchema, ...guarded },
      },
    },
    async (request, reply) => {
      const user = await verifier(request);
      reply.header("cache-control", "no-store");
      return listQueue(app.db, user.id, request.query.status);
    },
  );

  app.get(
    "/verifier/reports/:id",
    {
      schema: {
        tags: [TAG],
        summary: "Laporan untuk diperiksa",
        description:
          "Semua isian, foto (tanpa alamat; dibuka lewat `GET /verifier/photos/{id}`), titik, klarifikasi, data lokasi saat ini untuk dibandingkan, dan lokasi mirip di sekitar (FR-31). Pelapor hanya disebut dengan nama tampilan. Laporan sendiri menjawab 403 `laporan_sendiri` (FR-37).",
        params: reportIdParams,
        response: { 200: review, 400: errorSchema, 404: errorSchema, ...guarded },
      },
    },
    async (request, reply) => {
      const user = await verifier(request);
      reply.header("cache-control", "no-store");
      return getReview(app.db, user.id, request.params.id, { photoBaseUrl: opts.photoBaseUrl });
    },
  );

  app.get(
    "/verifier/places/recheck",
    {
      schema: {
        tags: [TAG],
        summary: "Lokasi yang perlu dicek ulang",
        description: "Lokasi yang terakhir diverifikasi lebih dari 12 bulan lalu, terlama dulu, paling banyak 100 (FR-38). Pengecekan ulang memakai Edit lokasi.",
        response: { 200: recheckList, ...guarded },
      },
    },
    async (request, reply) => {
      await verifier(request);
      reply.header("cache-control", "no-store");
      return listRecheck(app.db, opts.now());
    },
  );
};
