import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { HttpError, errorSchema } from "../http/errors.js";
import { SearchQuotaError, type SearchPoint, type SearchResult } from "../map/search.js";
import type { MapToken } from "../map/token.js";
import { placesNamed } from "../places/queries.js";
import { placeCategory, placeStatus } from "../db/schema.js";
import { line, point } from "../reports/schemas.js";

const mapToken = z.object({
  token: z.string().describe("Token Mapbox sementara (tk.) untuk Mapbox GL JS"),
  expiresAt: z.iso.datetime().describe("Waktu token berhenti berlaku; minta token baru sebelum waktu ini"),
});

const location = z.object({ lat: z.number(), lng: z.number() });

const searchBody = z.object({
  q: line(100).min(2).describe("Kata kunci: nama tempat atau alamat"),
  near: point.optional().describe("Tengah peta yang sedang dilihat, untuk mendahulukan hasil terdekat"),
});

const searchResult = z
  .object({
    places: z
      .array(
        z.object({
          id: z.uuid(),
          name: z.string(),
          category: z.enum(placeCategory.enumValues),
          status: z.enum(placeStatus.enumValues),
          district: z.object({ slug: z.string(), name: z.string() }),
          location,
        }),
      )
      .describe("Lokasi AksesBogor yang sudah terbit dengan nama mirip, paling banyak 3 (FR-23)"),
    results: z
      .array(
        z.object({
          name: z.string(),
          address: z.string().nullable(),
          location,
          kind: z.string().describe("Jenis hasil Mapbox, mis. poi, address, street"),
        }),
      )
      .describe("Hasil Mapbox, paling banyak 5. Hanya untuk menggeser peta; tidak boleh disimpan"),
  })
  .describe("Hasil pencarian tempat");

type MapRouteOptions = {
  /** Kosong bila MAPBOX_SECRET_TOKEN belum diatur. */
  mapToken?: () => Promise<MapToken>;
  /** Pencarian Mapbox Search Box; kosong bila MAPBOX_SECRET_TOKEN belum diatur. */
  search?: (query: string, near?: SearchPoint) => Promise<SearchResult[]>;
};

export const mapRoutes: FastifyPluginAsyncZod<MapRouteOptions> = async (app, opts) => {
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

  app.post(
    "/map/search",
    {
      schema: {
        tags: ["Peta"],
        summary: "Cari tempat untuk pemilih lokasi",
        description:
          "Lokasi AksesBogor bernama mirip, lalu hasil Mapbox Search Box di sekitar Kota Bogor (FR-21, ADR-0032). Tanpa akun. Kata kunci dikirim di badan permintaan supaya tidak tercatat di log. 30 pencarian per menit per klien dan 1.500 per hari untuk semua pengguna; setelah itu 503 `pencarian_penuh`.",
        body: searchBody,
        response: { 200: searchResult, 400: errorSchema, 429: errorSchema, 502: errorSchema, 503: errorSchema },
      },
      config: {
        rateLimit: {
          max: 30,
          timeWindow: 60_000,
          errorResponseBuilder: () => new HttpError(429, "terlalu_sering", "Terlalu banyak pencarian. Tunggu sebentar, lalu coba lagi."),
        },
      },
    },
    async (request, reply) => {
      if (!opts.search) throw new HttpError(503, "pencarian_belum_diatur", "Pencarian tempat belum diatur di server. Geser peta atau pakai lokasi Anda.");
      const { q, near } = request.body;
      let results: SearchResult[];
      try {
        results = await opts.search(q, near);
      } catch (error) {
        if (error instanceof SearchQuotaError) {
          throw new HttpError(503, "pencarian_penuh", "Pencarian tempat sudah mencapai batas hari ini. Geser peta atau pakai lokasi Anda.");
        }
        request.log.warn({ err: error }, "pencarian Mapbox gagal");
        throw new HttpError(502, "pencarian_gagal", "Pencarian tempat sedang gangguan. Coba lagi, atau geser peta.");
      }
      reply.header("cache-control", "no-store");
      return { places: await placesNamed(app.db, q), results };
    },
  );
};
