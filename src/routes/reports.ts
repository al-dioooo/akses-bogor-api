import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Auth } from "../auth/auth.js";
import { needsCompletion, requireSession } from "../auth/session.js";
import { photos } from "../db/schema.js";
import { HttpError, errorSchema } from "../http/errors.js";
import { MAX_PHOTO_BYTES, photoTooLarge, processPhoto } from "../photos/process.js";
import { reportPhotoKey, type PhotoStore } from "../photos/storage.js";
import { nearbyPlaces, requireDistrict } from "../reports/location.js";
import { locationCheck, locationCheckBody } from "../reports/schemas.js";

const TAG = "Laporkan";
const HOUR_MS = 60 * 60 * 1000;
/** Unggahan foto per akun per jam (ADR-0033): cukup untuk 10 laporan penuh. */
export const PHOTO_UPLOADS_PER_HOUR = 100;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

export type ReportRouteOptions = {
  /** Kosong bila `BETTER_AUTH_SECRET` belum diatur di production. */
  auth?: Auth;
  /** R2 atau folder lokal; kosong di production tanpa R2. */
  store?: PhotoStore;
  now: () => Date;
};

const uploaded = z
  .object({
    id: z.uuid().describe("Id foto, dikirim bersama laporan di `photos[].id`"),
    width: z.number().int(),
    height: z.number().int(),
    bytes: z.number().int().describe("Ukuran WebP yang disimpan"),
  })
  .describe("Foto tersimpan, belum terpasang ke laporan");

/** Route Laporkan (FR-20 sampai FR-27). Laporan masuk antrean verifikasi dan tidak menerbitkan apa pun (ADR-0006). */
export const reportRoutes: FastifyPluginAsyncZod<ReportRouteOptions> = async (app, opts) => {
  /** Akun yang boleh mengirim laporan: sudah masuk dan sudah melengkapi akun (FR-11). */
  const reporter = async (request: FastifyRequest) => {
    if (!opts.auth) throw new HttpError(503, "akun_belum_diatur", "Fitur akun belum diatur di server.");
    const { user } = await requireSession(opts.auth, app.db, request, opts.now);
    if (needsCompletion(user)) throw new HttpError(403, "akun_belum_lengkap", "Lengkapi akun dulu sebelum mengirim laporan.");
    return user;
  };

  // Foto dikirim sebagai badan mentah; hanya berlaku di route dalam plugin ini.
  app.addContentTypeParser(PHOTO_TYPES, { parseAs: "buffer", bodyLimit: MAX_PHOTO_BYTES }, (_request, body, done) => done(null, body));

  const uploaderOf = new WeakMap<FastifyRequest, string>();
  const perAccountUploads = app.createRateLimit({
    max: PHOTO_UPLOADS_PER_HOUR,
    timeWindow: HOUR_MS,
    keyGenerator: (request) => `foto:${uploaderOf.get(request)}`,
  });

  app.post(
    "/reports/location-check",
    {
      schema: {
        tags: [TAG],
        summary: "Cek titik laporan",
        description:
          "Kecamatan dari titik dan lokasi terbit dengan nama mirip dalam radius sekitar 50 m (FR-22, FR-23). Tanpa akun, karena hanya membaca data publik (ADR-0033). Titik dikirim di badan permintaan supaya tidak tercatat di log. Titik di luar Kota Bogor menjawab 422 `di_luar_kota_bogor`.",
        body: locationCheckBody,
        response: { 200: locationCheck, 400: errorSchema, 422: errorSchema },
      },
    },
    async (request, reply) => {
      const { location, name, placeId } = request.body;
      const district = await requireDistrict(app.db, location);
      reply.header("cache-control", "no-store");
      return { district, nearby: await nearbyPlaces(app.db, location, name, placeId) };
    },
  );

  app.post(
    "/reports/photos",
    {
      schema: {
        tags: [TAG],
        summary: "Unggah satu foto laporan",
        description:
          "Badan permintaan berisi berkas foto mentah dengan `content-type` image/jpeg, image/png, atau image/webp, maksimal 3 MB (ADR-0023, ADR-0031). Jenis dibaca dari byte awal; foto lebih dari 40 megapiksel atau beranimasi ditolak. Foto disimpan sebagai WebP ≤2048 px tanpa metadata di bucket privat, lalu dipasang ke laporan lewat `POST /reports`. Foto yang tidak dipasang dalam 24 jam dihapus. 100 unggahan per akun per jam.",
        consumes: PHOTO_TYPES,
        response: { 201: uploaded, 400: errorSchema, 401: errorSchema, 403: errorSchema, 413: errorSchema, 415: errorSchema, 429: errorSchema, 502: errorSchema, 503: errorSchema },
      },
      errorHandler: (error) => {
        // Galat dari parser badan permintaan diberi kode dan pesan foto; galat lain diteruskan ke error handler utama.
        if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") throw photoTooLarge();
        if (error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") throw new HttpError(415, "jenis_foto_tidak_didukung", "Foto harus berformat JPEG, PNG, atau WebP.");
        throw error;
      },
    },
    async (request, reply) => {
      const user = await reporter(request);
      if (!opts.store) throw new HttpError(503, "foto_belum_diatur", "Unggah foto belum diatur di server. Laporan tetap bisa dikirim tanpa foto.");
      uploaderOf.set(request, user.id);
      const limit = await perAccountUploads(request);
      if (!limit.isAllowed && limit.isExceeded) {
        reply.header("retry-after", Math.ceil(limit.ttl / 1000));
        throw new HttpError(429, "foto_terlalu_sering", `Sudah ${PHOTO_UPLOADS_PER_HOUR} foto diunggah dalam satu jam. Coba lagi nanti.`);
      }
      // Content-Type lain (mis. text/plain) dibaca parser bawaan Fastify sebagai teks, bukan berkas.
      if (!Buffer.isBuffer(request.body)) throw new HttpError(415, "jenis_foto_tidak_didukung", "Foto harus berformat JPEG, PNG, atau WebP.");
      const photo = await processPhoto(request.body);
      const id = randomUUID();
      const storageKey = reportPhotoKey(id);
      // Baris dulu, lalu berkas: bila menyimpan berkas gagal, barisnya dibuang sehingga tidak ada berkas tanpa baris.
      await app.db
        .insert(photos)
        .values({ id, uploaderId: user.id, storageKey, altText: "", width: photo.width, height: photo.height, bytes: photo.bytes, createdAt: opts.now() });
      try {
        await opts.store.put(storageKey, photo.data, photo.contentType);
      } catch (error) {
        await app.db.delete(photos).where(eq(photos.id, id));
        request.log.warn({ err: error }, "foto gagal disimpan");
        throw new HttpError(502, "foto_gagal_disimpan", "Foto gagal disimpan. Coba unggah lagi.");
      }
      return reply.code(201).send({ id, width: photo.width, height: photo.height, bytes: photo.bytes });
    },
  );
};
