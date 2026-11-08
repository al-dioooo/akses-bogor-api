import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { Auth } from "../auth/auth.js";
import { requireVerifier } from "../auth/session.js";
import { HttpError, errorSchema } from "../http/errors.js";
import { blurPhoto } from "../photos/blur.js";
import type { PhotoStore } from "../photos/storage.js";
import { rejectReport, requestClarification } from "../verification/decide.js";
import { sendReportEmails, type EmailOptions } from "../verification/emails.js";
import { publishReport } from "../verification/publish.js";
import { moderatePhoto, photoForReview } from "../verification/photos.js";
import { getReview, listQueue, listRecheck } from "../verification/queue.js";
import { clarifyBody, decision, moderationBody, photoIdParams, publishBody, rejectBody, photoVersionQuery, queue, queueQuery, recheckList, reportIdParams, reportPhotoParams, review, reviewPhoto } from "../verification/schemas.js";

export type VerifierRouteOptions = {
  auth?: Auth;
  /** Alamat publik bucket foto, untuk foto lokasi yang sudah tayang. */
  photoBaseUrl?: string;
  /** R2 atau folder lokal; kosong di production tanpa R2. */
  store?: PhotoStore;
  /** Pengirim dan alamat web untuk email status laporan (ADR-0039). */
  email: EmailOptions;
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
  /** Mengirim email keputusan setelah transaksi selesai; yang gagal dicoba lagi tugas berkala (ADR-0039). */
  const notify = async (request: FastifyRequest, reportId: string) => {
    try {
      await sendReportEmails(app.db, opts.email, opts.now(), { reportId, log: request.log });
    } catch (error) {
      request.log.warn({ err: error, reportId }, "email status laporan gagal dikirim");
    }
  };

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
    "/verifier/photos/:id",
    {
      schema: {
        tags: [TAG],
        summary: "Foto laporan yang belum terbit",
        description:
          "Berkas WebP dari bucket privat, hanya untuk verifikator dan admin, dengan `Cache-Control: private, no-store` (ADR-0031, ADR-0037). `versi=kabur` memakai area kabur yang tersimpan, sama dengan hasil saat terbit. Foto laporan sendiri 403; foto yang sudah terbit 404 (pakai alamat publiknya).",
        params: photoIdParams,
        querystring: photoVersionQuery,
        produces: ["image/webp"],
        response: { 400: errorSchema, 404: errorSchema, 502: errorSchema, ...guarded },
      },
    },
    async (request, reply) => {
      const user = await verifier(request);
      if (!opts.store) throw new HttpError(503, "foto_belum_diatur", "Penyimpanan foto belum diatur di server.");
      const photo = await photoForReview(app.db, user.id, request.params.id);
      let data: Uint8Array;
      try {
        data = await opts.store.get(photo.storageKey);
      } catch (error) {
        request.log.warn({ err: error }, "foto laporan gagal dibaca");
        throw new HttpError(502, "foto_gagal_dibaca", "Foto gagal dibaca dari penyimpanan. Coba lagi.");
      }
      if (request.query.versi === "kabur" && photo.blur.length > 0) data = (await blurPhoto(data, photo.blur)).data;
      // Berkas biner tanpa skema 200, jadi Fastify mengirimnya apa adanya; tipe reply hanya mengenal skema galat.
      return reply.header("cache-control", "private, no-store").type("image/webp").send(Buffer.from(data) as never);
    },
  );

  app.patch(
    "/verifier/reports/:id/photos/:photoId",
    {
      schema: {
        tags: [TAG],
        summary: "Moderasi foto laporan",
        description:
          "Memperbaiki tag dan keterangan, menyembunyikan foto, atau mengganti area kabur (paling banyak 20, dalam pecahan 0 sampai 1) sebelum keputusan (FR-34, ADR-0037). Tersimpan langsung dan dicatat di log audit tanpa isi keterangan. Laporan yang sudah diputuskan 409 `sudah_diputuskan`.",
        params: reportPhotoParams,
        body: moderationBody,
        response: { 200: reviewPhoto, 400: errorSchema, 404: errorSchema, 409: errorSchema, ...guarded },
      },
    },
    async (request) => {
      const user = await verifier(request);
      return moderatePhoto(app.db, user.id, request.params.id, request.params.photoId, request.body, opts.now());
    },
  );

  app.post(
    "/verifier/reports/:id/publish",
    {
      schema: {
        tags: [TAG],
        summary: "Terbitkan laporan",
        description:
          "Membuat lokasi baru, atau memperbarui lokasi yang sama untuk perubahan dan kekurangan (FR-27, FR-32, FR-33, ADR-0036). Jawaban tanpa bukti menjadi Belum tahu, dan status dihitung dengan aturan pintu masuk dulu. Foto yang tidak disembunyikan disalin ke bucket publik dengan area kabur; foto asli dan foto tersembunyi dihapus (ADR-0037). Galat: 400 `alasan_wajib` atau `isian_wajib`, 409 `sudah_diputuskan` atau `lokasi_berubah`, 422 `di_luar_kota_bogor`, 502 `foto_gagal_diterbitkan`. Pelapor mendapat email (FR-40).",
        params: reportIdParams,
        body: publishBody,
        response: { 200: decision, 400: errorSchema, 404: errorSchema, 409: errorSchema, 422: errorSchema, 502: errorSchema, ...guarded },
      },
    },
    async (request) => {
      const user = await verifier(request);
      const result = await publishReport(app.db, opts.store, user.id, request.params.id, request.body, opts.now(), request.log);
      await notify(request, request.params.id);
      return { status: "diterbitkan" as const, placeId: result.placeId };
    },
  );

  app.post(
    "/verifier/reports/:id/reject",
    {
      schema: {
        tags: [TAG],
        summary: "Tolak laporan",
        description:
          "Menolak dengan alasan baku R1 sampai R5 (FR-32). Semua foto laporan dihapus; isian tetap ada untuk Laporan saya. Pelapor mendapat email berisi pesan baku alasannya (FR-40). Laporan yang sudah diputuskan 409 `sudah_diputuskan`; laporan sendiri 403.",
        params: reportIdParams,
        body: rejectBody,
        response: { 200: decision, 400: errorSchema, 404: errorSchema, 409: errorSchema, ...guarded },
      },
    },
    async (request) => {
      const user = await verifier(request);
      await rejectReport(app.db, opts.store, user.id, request.params.id, request.body, opts.now());
      await notify(request, request.params.id);
      return { status: "ditolak" as const, rejectionReason: request.body.reason };
    },
  );

  app.post(
    "/verifier/reports/:id/clarify",
    {
      schema: {
        tags: [TAG],
        summary: "Minta klarifikasi",
        description:
          "Mengirim pertanyaan ke pelapor lewat email dengan tenggat 7 × 24 jam (FR-32, FR-41, ADR-0036). Tanpa jawaban sampai tenggat, laporan ditolak otomatis dengan R6. Hanya dari status menunggu; laporan yang masih menunggu jawaban 409 `klarifikasi_terbuka`.",
        params: reportIdParams,
        body: clarifyBody,
        response: { 200: decision, 400: errorSchema, 404: errorSchema, 409: errorSchema, ...guarded },
      },
    },
    async (request) => {
      const user = await verifier(request);
      const result = await requestClarification(app.db, user.id, request.params.id, request.body, opts.now());
      await notify(request, request.params.id);
      return { status: result.status, clarificationDueAt: result.dueAt };
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
