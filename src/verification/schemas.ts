// Skema Zod untuk panel verifikator (FR-30 sampai FR-38, ADR-0035 sampai ADR-0037). Juga menjadi API spec.
import { z } from "zod";
import { placeCategory, placeStatus, reportKind } from "../db/schema.js";

const category = z.enum(placeCategory.enumValues);
const district = z.object({ slug: z.string(), name: z.string() });

export const queueQuery = z.object({
  status: z.enum(["menunggu", "klarifikasi"]).default("menunggu").describe("menunggu: antrean; klarifikasi: menunggu jawaban pelapor"),
});

export const queueItem = z.object({
  id: z.uuid(),
  kind: z.enum(reportKind.enumValues),
  status: z.enum(["menunggu", "klarifikasi"]),
  placeId: z.uuid().nullable(),
  name: z.string().describe("Nama tempat dari isian laporan"),
  category,
  district,
  reporterName: z.string().describe("Nama tampilan pelapor, bukan email (FR-37)"),
  photos: z.number().int(),
  submittedAt: z.iso.datetime().describe("Urutan antrean: terlama dulu (FR-30)"),
  answered: z.boolean().describe("Pelapor sudah menjawab klarifikasi; laporan kembali ke posisi aslinya"),
  clarificationDueAt: z.iso.datetime().nullable().describe("Tenggat jawaban bila statusnya klarifikasi"),
  worsens: z.boolean().describe("Laporan perubahan atau kekurangan yang membuat fasilitas Tersedia atau Tidak perlu menjadi Tidak tersedia; dahulukan"),
});

export const queue = z.object({ total: z.number().int(), items: z.array(queueItem) }).describe("Antrean verifikasi, paling banyak 100 laporan");

export const recheckList = z
  .object({
    total: z.number().int(),
    items: z.array(z.object({ id: z.uuid(), name: z.string(), category, district, status: z.enum(placeStatus.enumValues), lastVerifiedAt: z.iso.datetime() })),
  })
  .describe("Lokasi yang terakhir diverifikasi lebih dari 12 bulan lalu, terlama dulu (FR-38)");
