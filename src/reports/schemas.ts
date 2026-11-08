// Skema Zod untuk route Laporkan (FR-20 sampai FR-27). Skema ini juga menjadi API spec (docs/openapi.json).
import { z } from "zod";
import { facilityAnswer, facilityKind, photoTag, placeCategory, placeStatus, reportKind, reportStatus, unavailableReason } from "../db/schema.js";

/** Teks satu baris dari pengguna: dipangkas dan tanpa karakter kontrol. */
export const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{C}]+$/u);

export const point = z
  .object({
    lat: z.number().min(-90).max(90).describe("Lintang (derajat, WGS 84)"),
    lng: z.number().min(-180).max(180).describe("Bujur (derajat, WGS 84)"),
  })
  .describe("Titik pin yang dikonfirmasi pelapor (ADR-0015)");

export const district = z.object({ slug: z.string(), name: z.string() }).describe("Kecamatan hasil hitung dari titik (FR-22)");

export const locationCheckBody = z.object({
  location: point,
  name: line(120).optional().describe("Nama tempat yang sedang diisi, untuk mencari lokasi mirip"),
  placeId: z.uuid().optional().describe("Lokasi yang sedang diedit, tidak ikut dianggap mirip"),
});

export const nearbyPlace = z.object({
  id: z.uuid(),
  name: z.string(),
  category: z.enum(placeCategory.enumValues),
  status: z.enum(placeStatus.enumValues),
  distanceMeters: z.number().int().describe("Jarak dari titik, dibulatkan ke meter"),
});

export const locationCheck = z
  .object({
    district,
    nearby: z.array(nearbyPlace).describe("Lokasi terbit dalam radius sekitar 50 m dengan nama mirip, terdekat dulu (FR-23)"),
  })
  .describe("Hasil pengecekan lokasi");

/** Teks beberapa baris (deskripsi): boleh baris baru dan tab, tanpa karakter kontrol lain. */
const paragraph = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^(?:[^\p{C}]|[\n\r\t])+$/u);

const facilityInput = z
  .object({
    facility: z.enum(facilityKind.enumValues),
    answer: z.enum(facilityAnswer.enumValues).describe("Bawaan di formulir: belum_tahu (ADR-0017)"),
    reason: z.enum(unavailableReason.enumValues).optional().describe("Hanya untuk tidak_tersedia, boleh dilewati (ADR-0022)"),
    note: line(200).optional().describe("Catatan singkat, maksimal 200 karakter, tanpa data pribadi (ADR-0022)"),
  })
  .refine((f) => !f.reason || f.answer === "tidak_tersedia", { message: "Alasan hanya untuk Tidak tersedia", path: ["reason"] });

const photoInput = z.object({
  id: z.uuid().describe("Id dari `POST /reports/photos`"),
  tag: z.enum(photoTag.enumValues).describe("Objek di foto (ADR-0023)"),
  caption: line(200).optional().describe("Deskripsi tambahan untuk foto"),
});

/** Isian yang wajib ada untuk laporan baru dan perubahan; laporan kekurangan memakai data lokasi saat ini. */
const PLACE_FIELDS = ["name", "category", "location"] as const;

export const reportBody = z
  .object({
    submissionKey: z.uuid().describe("Kunci acak dari draf; kirim ulang dengan kunci sama mengembalikan laporan yang sudah ada (ADR-0033)"),
    kind: z.enum(reportKind.enumValues).describe("baru, perubahan (Edit lokasi), atau kekurangan (Laporkan kekurangan)"),
    placeId: z.uuid().optional().describe("Wajib untuk perubahan dan kekurangan; tidak boleh ada untuk laporan baru"),
    name: line(120).optional().describe("Nama tempat; wajib untuk baru dan perubahan"),
    category: z.enum(placeCategory.enumValues).optional().describe("Satu kategori; wajib untuk baru dan perubahan"),
    location: point.optional().describe("Pin yang dikonfirmasi; wajib untuk baru dan perubahan"),
    landmark: line(140).optional().describe("Patokan opsional"),
    description: paragraph(1000).optional().describe("Deskripsi tambahan"),
    facilities: z
      .array(facilityInput)
      .length(4)
      .refine((items) => new Set(items.map((f) => f.facility)).size === 4, "Setiap fasilitas dijawab tepat sekali")
      .describe("Jawaban untuk keempat fasilitas (FR-24)"),
    photos: z
      .array(photoInput)
      .max(10)
      .default([])
      .refine((items) => new Set(items.map((p) => p.id)).size === items.length, "Foto tidak boleh dobel")
      .describe("0 sampai 10 foto yang sudah diunggah akun ini (FR-25)"),
  })
  .superRefine((body, ctx) => {
    if (body.kind === "baru" && body.placeId) ctx.addIssue({ code: "custom", message: "Laporan baru tidak punya lokasi terkait", path: ["placeId"] });
    if (body.kind !== "baru" && !body.placeId) ctx.addIssue({ code: "custom", message: "Lokasi terkait wajib diisi", path: ["placeId"] });
    if (body.kind !== "kekurangan") {
      for (const field of PLACE_FIELDS) if (body[field] === undefined) ctx.addIssue({ code: "custom", message: "Wajib diisi", path: [field] });
    }
  });

export type ReportBody = z.infer<typeof reportBody>;

export const submittedReport = z
  .object({
    id: z.uuid(),
    kind: z.enum(reportKind.enumValues),
    status: z.enum(reportStatus.enumValues).describe("Selalu menunggu untuk laporan baru masuk"),
    placeId: z.uuid().nullable(),
    name: z.string().describe("Nama tempat yang dilaporkan"),
    district,
    photos: z.number().int().describe("Jumlah foto yang terpasang"),
    submittedAt: z.iso.datetime(),
  })
  .describe("Laporan masuk antrean verifikasi");
