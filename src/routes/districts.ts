import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { districtBoundaries, kecamatanPriority } from "../contribute/priority.js";
import { HttpError, errorSchema } from "../http/errors.js";
import { listDistricts } from "../places/queries.js";
import { districtList } from "../places/schemas.js";

export type DistrictRouteOptions = {
  /** `DISABILITY_DATA_ENABLED`. Mati sampai Diskominfo Kota Bogor mengizinkan pemakaian datanya (ADR-0043). */
  disabilityData: boolean;
};

const level = z.enum(["rendah", "sedang", "tinggi", "sangat_tinggi"]);
export const prioritySchema = z.object({
  year: z.number().int().describe("Tahun terbaru di data Dinsos"),
  yearTotals: z.array(z.object({ year: z.number().int(), registered: z.number().int() })).describe("Jumlah terdaftar per tahun, untuk menunjukkan lonjakan antartahun"),
  districts: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      registered: z.number().int().describe("Penyandang disabilitas terdaftar di Dinsos pada `year`, bukan jumlah seluruh penduduk"),
      verifiedPlaces: z.number().int().describe("Lokasi AksesBogor yang sudah terbit"),
      facilitiesWithoutData: z.number().int().describe("Kampus, masjid, halte, dan rumah sakit di OpenStreetMap yang belum punya data AksesBogor"),
      score: z.number().int().min(0).max(100),
      rank: z.number().int().min(1),
      level,
    }),
  ),
  caveat: z.string().describe("Kalimat yang wajib ikut setiap angka disabilitas"),
  formula: z.string(),
  source: z.object({ title: z.string(), url: z.url(), publisher: z.string(), retrievedAt: z.iso.datetime(), terms: z.string() }),
  facilitiesSource: z.object({ retrievedAt: z.iso.datetime().nullable(), attribution: z.string() }),
});
const boundariesSchema = z.object({
  type: z.literal("FeatureCollection"),
  attribution: z.string(),
  features: z.array(
    z.object({
      type: z.literal("Feature"),
      properties: z.object({ slug: z.string(), name: z.string() }),
      geometry: z.object({ type: z.string(), coordinates: z.unknown() }).describe("MultiPolygon, disederhanakan, 5 desimal"),
    }),
  ),
  outline: z
    .object({ type: z.literal("MultiPolygon"), coordinates: z.unknown() })
    .nullable()
    .describe("Batas Kota Bogor: gabungan keenam batas kecamatan tanpa lubang di antaranya, disederhanakan, 5 desimal (ADR-0053)"),
});

export const districtRoutes: FastifyPluginAsyncZod<DistrictRouteOptions> = async (app, opts) => {
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

  app.get(
    "/districts/boundaries",
    {
      schema: {
        tags: ["Lokasi"],
        summary: "Batas kecamatan",
        description: "Batas keenam kecamatan (ADR-0034) sebagai GeoJSON yang disederhanakan, untuk lapisan peta. Data © kontributor OpenStreetMap (ODbL).",
        response: { 200: boundariesSchema },
      },
    },
    async (_request, reply) => {
      reply.header("cache-control", "public, max-age=86400");
      return districtBoundaries(app.db);
    },
  );

  app.get(
    "/districts/priority",
    {
      schema: {
        tags: ["Lokasi"],
        summary: "Prioritas kecamatan untuk kontributor",
        description:
          "Skor 0–100 per kecamatan dari jumlah penyandang disabilitas terdaftar di Dinas Sosial (Open Data Kota Bogor, tahun terbaru) dan kekurangan data AksesBogor (ADR-0043). Menjawab 503 `data_disabilitas_belum_aktif` selama `DISABILITY_DATA_ENABLED` mati, karena syarat portal membatasi pemakaian untuk pihak ketiga tanpa izin Diskominfo.",
        response: { 200: prioritySchema, 503: errorSchema },
      },
    },
    async () => {
      if (!opts.disabilityData) throw new HttpError(503, "data_disabilitas_belum_aktif", "Data prioritas kecamatan belum dibuka.");
      const priority = await kecamatanPriority(app.db);
      if (!priority) throw new HttpError(503, "data_disabilitas_belum_dimuat", "Data prioritas kecamatan belum dimuat.");
      return priority;
    },
  );
};
