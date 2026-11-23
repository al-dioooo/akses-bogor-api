import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { getOsmPlace } from "../contribute/facilities.js";
import { candidateHintParams, hintsResponse } from "../hints/schemas.js";
import { lookupHints, type HintProvider } from "../hints/provider.js";
import { HttpError, errorSchema } from "../http/errors.js";
import { getPlace } from "../places/queries.js";
import { placeIdParams } from "../places/schemas.js";

export type HintRouteOptions = {
  /** Penyedia yang menyala; kosong bila `PROVIDER_HINTS_ENABLED` mati (ADR-0052). */
  providers: readonly HintProvider[];
  now: () => Date;
};

const DESCRIPTION =
  "Petunjuk dari penyedia peta, bukan data AksesBogor: belum diperiksa tim dan tidak mengubah status atau jawaban fasilitas (ADR-0052). Tempat penyedia diterima hanya bila paling jauh 75 m dan namanya mirip. Hasil penyedia tidak disimpan: Mapbox di-cache di memori 10 menit, dan dari Google hanya place_id. Jawaban `hints: []` berarti petunjuk dimatikan. 30 permintaan per menit per klien.";

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
      const place = await getPlace(app.db, request.params.id, opts.now());
      if (!place) throw new HttpError(404, "lokasi_tidak_ditemukan", "Lokasi tidak ditemukan.");
      reply.header("cache-control", "private, no-store");
      return { hints: await lookupHints({ name: place.name, location: place.location }, opts.providers) };
    },
  );

  app.get(
    "/places/candidates/:osmType/:osmId/hints",
    {
      schema: {
        tags: ["Lokasi"],
        summary: "Petunjuk aksesibilitas dari Mapbox dan Google untuk kandidat OpenStreetMap",
        description: `${DESCRIPTION} Kandidat tanpa nama tidak dicocokkan.`,
        params: candidateHintParams,
        response: { 200: hintsResponse, 400: errorSchema, 404: errorSchema, 429: errorSchema },
      },
      config: routeConfig,
    },
    async (request, reply) => {
      const place = await getOsmPlace(app.db, request.params);
      if (!place) throw new HttpError(404, "kandidat_tidak_ditemukan", "Tempat tidak ditemukan.");
      reply.header("cache-control", "private, no-store");
      return { hints: await lookupHints({ name: place.name, location: place.location }, opts.providers) };
    },
  );
};
