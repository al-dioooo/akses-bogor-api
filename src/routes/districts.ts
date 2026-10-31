import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { listDistricts } from "../places/queries.js";
import { districtList } from "../places/schemas.js";

export const districtRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/districts",
    {
      schema: {
        tags: ["Lokasi"],
        summary: "Daftar kecamatan",
        description: "Enam kecamatan Kota Bogor (ADR-0010) dengan jumlah lokasi terbit, untuk filter kecamatan.",
        response: { 200: districtList },
      },
    },
    async () => listDistricts(app.db),
  );
};
