import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { HttpError, errorSchema } from "../http/errors.js";
import { getPlace, listPlaces, mapPlaces, placeStats, type ReadOptions } from "../places/queries.js";
import { listQuery, mapQuery, placeDetail, placeIdParams, placeList, placeMap, placeStats as placeStatsSchema } from "../places/schemas.js";

export const placeRoutes: FastifyPluginAsyncZod<ReadOptions & { now: () => Date }> = async (app, opts) => {
  const read = { photoBaseUrl: opts.photoBaseUrl };

  app.get(
    "/places",
    {
      schema: {
        tags: ["Lokasi"],
        summary: "Daftar lokasi untuk Jelajahi",
        description: "Pencarian nama sebagian kata (FR-02) dan filter kategori, kecamatan, fasilitas, status (FR-03). Urut nama.",
        querystring: listQuery,
        response: { 200: placeList, 400: errorSchema },
      },
    },
    async (request) => listPlaces(app.db, request.query, read),
  );

  app.get(
    "/places/map",
    {
      schema: {
        tags: ["Lokasi"],
        summary: "Titik lokasi untuk peta",
        description: "GeoJSON FeatureCollection untuk sumber Mapbox, dengan filter yang sama seperti daftar (FR-05). Maksimal 2000 titik.",
        querystring: mapQuery,
        response: { 200: placeMap, 400: errorSchema },
      },
    },
    async (request) => mapPlaces(app.db, request.query),
  );

  app.get(
    "/places/stats",
    {
      schema: {
        tags: ["Lokasi"],
        summary: "Angka untuk Beranda",
        description: "Jumlah lokasi per kategori dan statistik dampak, dihitung dari data (FR-01).",
        response: { 200: placeStatsSchema },
      },
    },
    async () => placeStats(app.db),
  );

  app.get(
    "/places/:id",
    {
      schema: {
        tags: ["Lokasi"],
        summary: "Detail lokasi",
        description: "Fasilitas dengan alasan dan catatan, ringkasan X dari Y, fasilitas penentu status, foto, dan tanda perlu dicek ulang (FR-06, FR-07, FR-38).",
        params: placeIdParams,
        response: { 200: placeDetail, 400: errorSchema, 404: errorSchema },
      },
    },
    async (request) => {
      const place = await getPlace(app.db, request.params.id, opts.now(), read);
      if (!place) throw new HttpError(404, "lokasi_tidak_ditemukan", "Lokasi tidak ditemukan.");
      return place;
    },
  );
};
