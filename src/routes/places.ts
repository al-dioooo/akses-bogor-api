import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { listCandidates } from "../contribute/facilities.js";
import { HttpError, errorSchema } from "../http/errors.js";
import { getPlace, listPlaces, mapPlaces, placeStats, type ReadOptions } from "../places/queries.js";
import { candidateMap, candidateQuery, listQuery, mapQuery, placeDetail, placeIdParams, placeList, placeMap, placeStats as placeStatsSchema } from "../places/schemas.js";

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
    "/places/candidates",
    {
      schema: {
        tags: ["Lokasi"],
        summary: "Kandidat Belum ada data dari OpenStreetMap",
        description:
          "Kampus, masjid, halte, dan rumah sakit di OpenStreetMap tanpa lokasi AksesBogor berkategori sama dalam 50 m, untuk lapisan \"Belum ada data\" di Peta (ADR-0049). Kandidat belum diperiksa tim: tanpa status, tidak terhitung sebagai lokasi terbit, dan `wheelchair` adalah nilai mentah tag OSM. Data © kontributor OpenStreetMap (ODbL); atribusi di `source` wajib tampil bersama datanya.",
        querystring: candidateQuery,
        response: { 200: candidateMap, 400: errorSchema },
      },
    },
    async (request, reply) => {
      const { candidates, source } = await listCandidates(app.db, request.query);
      reply.header("cache-control", "public, max-age=300");
      return {
        type: "FeatureCollection" as const,
        features: candidates.map((c) => ({
          type: "Feature" as const,
          id: `${c.osm.osmType}/${c.osm.osmId}`,
          geometry: { type: "Point" as const, coordinates: [c.location.lng, c.location.lat] as [number, number] },
          properties: { osmType: c.osm.osmType as "node" | "way" | "relation", osmId: c.osm.osmId, name: c.name, category: c.category, district: c.district, wheelchair: c.wheelchair },
        })),
        source,
      };
    },
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
