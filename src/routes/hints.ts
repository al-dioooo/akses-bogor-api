import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { getOsmPlace } from "../contribute/facilities.js";
import { districtAccessibility } from "../hints/districts.js";
import { candidateHintParams, candidateHintsResponse, districtAccessibilityResponse, hintsResponse } from "../hints/schemas.js";
import { lookupHints, type HintProvider } from "../hints/provider.js";
import { storedHints, withStored } from "../hints/stored.js";
import { HttpError, errorSchema } from "../http/errors.js";
import { getPlace } from "../places/queries.js";
import { placeIdParams } from "../places/schemas.js";

export type HintRouteOptions = {
  /** Penyedia yang menyala; kosong bila `PROVIDER_HINTS_ENABLED` mati (ADR-0052). */
  providers: readonly HintProvider[];
  /** Salinan tersimpan di baris kandidat OSM ikut ditampilkan; mengikuti `PROVIDER_HINTS_ENABLED`. */
  stored: boolean;
  now: () => Date;
};

const DESCRIPTION =
  "Petunjuk dari penyedia peta, bukan data AksesBogor: belum diperiksa tim dan tidak mengubah status atau jawaban fasilitas (ADR-0052). Tempat penyedia diterima hanya bila paling jauh 75 m, namanya mirip terhadap kedua nama, angka dan huruf tunggalnya sama, kata jenis tempatnya sesuai, dan kategori penyedianya sesuai. Hasil penyedia tidak disimpan: Mapbox di-cache di memori 10 menit, dan dari Google hanya place_id. Jawaban `hints: []` berarti petunjuk dimatikan atau tidak ada penyedia yang menyala; saat itu tempatnya tidak diperiksa. 30 permintaan per menit per klien.";

/** Tidak disimpan browser atau Cloudflare, dan dibatasi karena setiap petunjuk berarti panggilan berbayar ke penyedia. */
const routeConfig = {
  rateLimit: {
    max: 30,
    timeWindow: 60_000,
    errorResponseBuilder: () => new HttpError(429, "terlalu_sering", "Terlalu banyak permintaan petunjuk. Tunggu sebentar, lalu coba lagi."),
  },
};

export const hintRoutes: FastifyPluginAsyncZod<HintRouteOptions> = async (app, opts) => {
  app.get(
    "/places/:id/hints",
    {
      schema: {
        tags: ["Lokasi"],
        summary: "Petunjuk aksesibilitas dari Mapbox dan Google untuk lokasi AksesBogor",
        description: DESCRIPTION,
        params: placeIdParams,
        response: { 200: hintsResponse, 400: errorSchema, 404: errorSchema, 429: errorSchema },
      },
      config: routeConfig,
    },
    async (request, reply) => {
      reply.header("cache-control", "private, no-store");
      if (opts.providers.length === 0) return { hints: [] };
      const place = await getPlace(app.db, request.params.id, opts.now());
      if (!place) throw new HttpError(404, "lokasi_tidak_ditemukan", "Lokasi tidak ditemukan.");
      return { hints: await lookupHints({ name: place.name, location: place.location, category: place.category }, opts.providers, request.log) };
    },
  );

  app.get(
    "/places/candidates/:osmType/:osmId/hints",
    {
      schema: {
        tags: ["Lokasi"],
        summary: "Petunjuk aksesibilitas dari Mapbox dan Google untuk kandidat OpenStreetMap",
        description: `${DESCRIPTION} Kandidat tanpa nama tidak dicocokkan. Untuk sebagian kandidat, jawaban juga membawa salinan tersimpan (result \`stored\`): Google Maps dengan tanggal pengambilannya, dan keterangan wheelchair OSM.`,
        params: candidateHintParams,
        response: { 200: candidateHintsResponse, 400: errorSchema, 404: errorSchema, 429: errorSchema },
      },
      config: routeConfig,
    },
    async (request, reply) => {
      reply.header("cache-control", "private, no-store");
      if (opts.providers.length === 0 && !opts.stored) return { hints: [] };
      const place = await getOsmPlace(app.db, request.params);
      if (!place) throw new HttpError(404, "kandidat_tidak_ditemukan", "Tempat tidak ditemukan.");
      const live = await lookupHints({ name: place.name, location: place.location, category: place.category }, opts.providers, request.log);
      return { hints: opts.stored ? withStored(live, await storedHints(app.db, request.params)) : live };
    },
  );

  app.get(
    "/districts/accessibility",
    {
      schema: {
        tags: ["Lokasi"],
        summary: "Kecamatan paling aksesibel menurut keterangan pintu masuk",
        description:
          "Per kecamatan: tempat (lokasi AksesBogor terbit dan kandidat OSM tanpa data AksesBogor) yang punya keterangan pintu masuk, berapa yang bisa dimasuki kursi roda, skor, peringkat, dan rincian per sumber (ADR-0053). Setiap tempat memakai sumber pertama yang punya keterangan: jawaban Ramp AksesBogor, tag `wheelchair` OSM, lalu salinan tersimpan OSM dan Google Maps (hanya selama `PROVIDER_HINTS_ENABLED` menyala). Keterangan selain AksesBogor belum diperiksa tim. Kecamatan dengan kurang dari `minimumPlaces` tempat ber-keterangan tidak diberi skor. Tidak disimpan browser atau Cloudflare, seperti petunjuk penyedia.",
        response: { 200: districtAccessibilityResponse },
      },
    },
    async (_request, reply) => {
      reply.header("cache-control", "private, no-store");
      return districtAccessibility(app.db, { stored: opts.stored });
    },
  );
};
