import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { createPlace, restorePlace, unpublishPlace, updatePlace } from "../admin/edit.js";
import { getAdminPlace, listAdminPlaces, listCandidates, placeHistory } from "../admin/places.js";
import {
  adminPlaceBody,
  adminPlaceDetail,
  adminPlaceList,
  adminPlaceQuery,
  adminPlaceUpdateBody,
  candidateList,
  candidateQuery,
  placeHistory as historySchema,
  reasonBody,
  saveResult,
} from "../admin/schemas.js";
import type { Auth } from "../auth/auth.js";
import { requireAdmin } from "../auth/session.js";
import { HttpError, errorSchema } from "../http/errors.js";
import type { PhotoStore } from "../photos/storage.js";
import { placeIdParams } from "../places/schemas.js";

export type AdminPlaceRouteOptions = { auth?: Auth; photoBaseUrl?: string; store?: PhotoStore; now: () => Date };

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

  const evidence = "Tersedia dan Tidak perlu tanpa foto bertag fasilitas itu (pintu masuk untuk ramp) disimpan sebagai Belum tahu dan disebut di `downgraded`; setiap Tidak tersedia butuh alasan (400 `alasan_wajib`).";

  app.post(
    "/admin/places",
    {
      schema: {
        tags: [TAG],
        summary: "Tambah tempat",
        description: `Tempat baru langsung tayang dengan label "Diterbitkan langsung oleh admin" (ADR-0050). Disimpan sebagai laporan milik admin yang langsung diterbitkan lewat validasi yang sama dengan verifikasi; titik di luar Kota Bogor 422. ${evidence} Foto harus diunggah akun ini lewat \`POST /reports/photos\`. Alasan masuk log audit.`,
        body: adminPlaceBody,
        response: { 201: saveResult, 400: errorSchema, 422: errorSchema, 502: errorSchema, ...guarded },
      },
    },
    async (request, reply) => {
      const user = await admin(request);
      const saved = await createPlace(app.db, opts.store, user.id, request.body, opts.now(), request.log);
      return reply.code(201).send({ placeId: saved.placeId, status: saved.status, downgraded: saved.downgraded });
    },
  );

  app.patch(
    "/admin/places/:id",
    {
      schema: {
        tags: [TAG],
        summary: "Ubah tempat",
        description: `Mengganti data, jawaban, dan foto tempat yang masih tayang; tempat menjadi berlabel admin. \`version\` yang tidak sama dengan data terbaru menjawab 409 \`lokasi_berubah\`; tempat yang diturunkan 409 \`lokasi_diturunkan\`. Foto tayang yang tidak dihapus tetap menjadi bukti. ${evidence}`,
        params: placeIdParams,
        body: adminPlaceUpdateBody,
        response: { 200: saveResult, 400: errorSchema, 404: errorSchema, 409: errorSchema, 422: errorSchema, 502: errorSchema, ...guarded },
      },
    },
    async (request) => {
      const user = await admin(request);
      const saved = await updatePlace(app.db, opts.store, user.id, request.params.id, request.body, opts.now(), request.log);
      return { placeId: saved.placeId, status: saved.status, downgraded: saved.downgraded };
    },
  );

  app.delete(
    "/admin/places/:id",
    {
      schema: {
        tags: [TAG],
        summary: "Turunkan tempat",
        description: "Menurunkan tempat dari tayang dengan alasan wajib. Tidak ada yang dihapus: laporan yang merujuknya tetap utuh, dan admin bisa menayangkannya lagi (ADR-0050). Sudah diturunkan: 409 `sudah_diturunkan`.",
        params: placeIdParams,
        body: reasonBody,
        response: { 204: z.null(), 400: errorSchema, 404: errorSchema, 409: errorSchema, ...guarded },
      },
    },
    async (request, reply) => {
      const user = await admin(request);
      await unpublishPlace(app.db, user.id, request.params.id, request.body.reason, opts.now());
      return reply.code(204).send(null);
    },
  );

  app.post(
    "/admin/places/:id/restore",
    {
      schema: {
        tags: [TAG],
        summary: "Tayangkan lagi",
        description: "Menayangkan lagi tempat yang diturunkan, dengan alasan wajib. Data tempat tidak berubah. Masih tayang: 409 `masih_tayang`.",
        params: placeIdParams,
        body: reasonBody,
        response: { 204: z.null(), 400: errorSchema, 404: errorSchema, 409: errorSchema, ...guarded },
      },
    },
    async (request, reply) => {
      const user = await admin(request);
      await restorePlace(app.db, user.id, request.params.id, request.body.reason, opts.now());
      return reply.code(204).send(null);
    },
  );
};
