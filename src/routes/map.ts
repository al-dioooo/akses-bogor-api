import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { HttpError, errorSchema } from "../http/errors.js";
import type { MapToken } from "../map/token.js";

const mapToken = z.object({
  token: z.string().describe("Token Mapbox sementara (tk.) untuk Mapbox GL JS"),
  expiresAt: z.iso.datetime().describe("Waktu token berhenti berlaku; minta token baru sebelum waktu ini"),
});

/** `mapToken` kosong bila MAPBOX_SECRET_TOKEN belum diatur. */
export const mapRoutes: FastifyPluginAsyncZod<{ mapToken?: () => Promise<MapToken> }> = async (app, opts) => {
  app.get(
    "/map/token",
    {
      schema: {
        tags: ["Peta"],
        summary: "Token peta untuk browser",
        description:
          "Token Mapbox sementara untuk halaman Peta (FR-05, ADR-0016). Satu token dipakai bersama dan diberikan selama sisa umurnya lebih dari 15 menit. Token rahasia tidak pernah dikirim.",
        response: { 200: mapToken, 502: errorSchema, 503: errorSchema },
      },
    },
    async (request, reply) => {
      if (!opts.mapToken) throw new HttpError(503, "peta_belum_diatur", "Peta belum diatur di server.");
      let token: MapToken;
      try {
        token = await opts.mapToken();
      } catch (error) {
        request.log.warn({ err: error }, "token Mapbox gagal dibuat");
        throw new HttpError(502, "peta_tidak_tersedia", "Peta sedang tidak bisa dimuat. Coba lagi sebentar lagi.");
      }
      reply.header("cache-control", "no-store");
      return token;
    },
  );
};
