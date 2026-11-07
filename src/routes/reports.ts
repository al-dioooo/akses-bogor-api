import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { errorSchema } from "../http/errors.js";
import { nearbyPlaces, requireDistrict } from "../reports/location.js";
import { locationCheck, locationCheckBody } from "../reports/schemas.js";

const TAG = "Laporkan";

/** Route Laporkan (FR-20 sampai FR-27). Laporan masuk antrean verifikasi dan tidak menerbitkan apa pun (ADR-0006). */
export const reportRoutes: FastifyPluginAsyncZod = async (app) => {
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
};
