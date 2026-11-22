import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { getAdminPlace, listAdminPlaces, listCandidates, placeHistory } from "../admin/places.js";
import { adminPlaceDetail, adminPlaceList, adminPlaceQuery, candidateList, candidateQuery, placeHistory as historySchema } from "../admin/schemas.js";
import type { Auth } from "../auth/auth.js";
import { requireAdmin } from "../auth/session.js";
import { HttpError, errorSchema } from "../http/errors.js";
import { placeIdParams } from "../places/schemas.js";

export type AdminPlaceRouteOptions = { auth?: Auth; photoBaseUrl?: string; now: () => Date };

const TAG = "Admin";

/**
 * Kelola tempat oleh admin (ADR-0050). Setiap route memeriksa sesi dan peran admin di sini, bukan di web; verifikator dan
 * pengguna mendapat 403.
 */
export const adminPlaceRoutes: FastifyPluginAsyncZod<AdminPlaceRouteOptions> = async (app, opts) => {
  const admin = (request: FastifyRequest) => {
    if (!opts.auth) throw new HttpError(503, "akun_belum_diatur", "Fitur akun belum diatur di server.");
    return requireAdmin(opts.auth, app.db, request, opts.now);
  };
  const guarded = { 401: errorSchema, 403: errorSchema, 503: errorSchema };

  app.get(
    "/admin/places",
    {
      schema: {
        tags: [TAG],
        summary: "Daftar tempat untuk admin",
        description: "Semua tempat, termasuk yang diturunkan beserta alasannya, urut nama, berhalaman. Saring nama, kategori, kecamatan, status, asal, dan keadaan tayang.",
        querystring: adminPlaceQuery,
        response: { 200: adminPlaceList, 400: errorSchema, ...guarded },
      },
    },
    async (request, reply) => {
      await admin(request);
      reply.header("cache-control", "no-store");
      return listAdminPlaces(app.db, request.query);
    },
  );

  app.get(
    "/admin/places/:id",
    {
      schema: {
        tags: [TAG],
        summary: "Satu tempat untuk formulir ubah",
        description: "Data lengkap, jawaban fasilitas, foto yang tayang, dan `version` untuk `PATCH`. Tempat yang diturunkan juga terbaca.",
        params: placeIdParams,
        response: { 200: adminPlaceDetail, 400: errorSchema, 404: errorSchema, ...guarded },
      },
    },
    async (request, reply) => {
      await admin(request);
      reply.header("cache-control", "no-store");
      return getAdminPlace(app.db, request.params.id, { photoBaseUrl: opts.photoBaseUrl });
    },
  );

  app.get(
    "/admin/places/:id/history",
    {
      schema: {
        tags: [TAG],
        summary: "Riwayat satu tempat",
        description: "Isi log audit untuk tempat ini, terbaru dulu, paling banyak 200 baris (ADR-0038). Pelaku ditulis dengan nama tampilan anggota tim; log tidak memuat email atau nama pelapor.",
        params: placeIdParams,
        response: { 200: historySchema, 400: errorSchema, 404: errorSchema, ...guarded },
      },
    },
    async (request, reply) => {
      await admin(request);
      reply.header("cache-control", "no-store");
      return placeHistory(app.db, request.params.id);
    },
  );

  app.get(
    "/admin/candidates",
    {
      schema: {
        tags: [TAG],
        summary: "Kandidat OpenStreetMap untuk dibuat menjadi tempat",
        description: "Kampus, masjid, halte, dan rumah sakit dari OpenStreetMap yang belum punya lokasi AksesBogor berkategori sama dalam 50 m (ADR-0049), berhalaman. Data © kontributor OpenStreetMap (ODbL).",
        querystring: candidateQuery,
        response: { 200: candidateList, 400: errorSchema, ...guarded },
      },
    },
    async (request, reply) => {
      await admin(request);
      reply.header("cache-control", "no-store");
      return listCandidates(app.db, request.query);
    },
  );
};
