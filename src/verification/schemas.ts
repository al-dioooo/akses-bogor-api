// Skema Zod untuk panel verifikator (FR-30 sampai FR-38, ADR-0035 sampai ADR-0037). Juga menjadi API spec.
import { z } from "zod";
import { facilityAnswer, facilityKind, photoTag, placeCategory, placeStatus, rejectionReason, reportKind, reportStatus, unavailableReason } from "../db/schema.js";
import { photo as publishedPhoto } from "../places/schemas.js";
import { MAX_BLUR_REGIONS } from "../photos/blur.js";
import { line, nearbyPlace } from "../reports/schemas.js";

const category = z.enum(placeCategory.enumValues);
const district = z.object({ slug: z.string(), name: z.string() });
const location = z.object({ lat: z.number(), lng: z.number() });

export const reportIdParams = z.object({ id: z.uuid() });

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

export const facilityValue = z.object({
  facility: z.enum(facilityKind.enumValues),
  answer: z.enum(facilityAnswer.enumValues),
  reason: z.enum(unavailableReason.enumValues).nullable(),
  note: z.string().nullable(),
});

export const blurRegion = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().gt(0).max(1),
    h: z.number().gt(0).max(1),
  })
  .refine((r) => r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001, "Area harus di dalam foto")
  .describe("Area kabur dalam pecahan 0 sampai 1 dari lebar dan tinggi foto (ADR-0037)");

export const photoIdParams = z.object({ id: z.uuid() });
export const reportPhotoParams = z.object({ id: z.uuid(), photoId: z.uuid() });
export const photoVersionQuery = z.object({
  versi: z.enum(["asli", "kabur"]).default("asli").describe("asli: foto apa adanya; kabur: pratinjau dengan area kabur yang tersimpan, sama dengan hasil terbit"),
});

export const moderationBody = z
  .object({
    hidden: z.boolean().optional().describe("Sembunyikan foto; foto tersembunyi dihapus saat laporan terbit"),
    tag: z.enum(photoTag.enumValues).optional().describe("Perbaiki tag (ADR-0023)"),
    caption: line(200).nullable().optional().describe("Keterangan yang tayang; null menghapusnya"),
    blur: z.array(blurRegion).max(MAX_BLUR_REGIONS).optional().describe("Menggantikan semua area kabur; kosong berarti tanpa area"),
  })
  .refine((body) => Object.keys(body).length > 0, "Tidak ada yang diubah");

export const reviewPhoto = z.object({
  id: z.uuid(),
  tag: z.enum(photoTag.enumValues),
  caption: z.string().nullable(),
  alt: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  hidden: z.boolean(),
  blur: z.array(blurRegion),
  clarificationId: z.uuid().nullable().describe("Foto dari jawaban klarifikasi"),
});

const statusPreview = z.object({
  status: z.enum(placeStatus.enumValues),
  available: z.number().int(),
  relevant: z.number().int(),
  unknown: z.number().int(),
});

export const review = z
  .object({
    id: z.uuid(),
    kind: z.enum(reportKind.enumValues),
    status: z.enum(reportStatus.enumValues),
    submittedAt: z.iso.datetime(),
    decidedAt: z.iso.datetime().nullable(),
    rejectionReason: z.enum(rejectionReason.enumValues).nullable(),
    reporterName: z.string().nullable().describe("Nama tampilan pelapor; kosong bila akunnya sudah dihapus (FR-37)"),
    reviewerNote: z.string().nullable().describe("Catatan internal verifikator (ADR-0036)"),
    submission: z.object({
      name: z.string(),
      category,
      location,
      district,
      landmark: z.string().nullable(),
      description: z.string().nullable(),
      facilities: z.array(facilityValue).describe("Jawaban pelapor, urut ramp, toilet, guiding block, lift"),
      status: statusPreview.describe("Status bila jawaban pelapor diterbitkan apa adanya"),
    }),
    photos: z.array(reviewPhoto),
    clarifications: z.array(
      z.object({
        id: z.uuid(),
        question: z.string(),
        askedAt: z.iso.datetime(),
        dueAt: z.iso.datetime(),
        answer: z.string().nullable(),
        answeredAt: z.iso.datetime().nullable(),
      }),
    ),
    place: z
      .object({
        id: z.uuid(),
        version: z.iso.datetime().describe("Kirim balik saat menerbitkan; berbeda berarti lokasi sudah berubah (409 `lokasi_berubah`)"),
        name: z.string(),
        category,
        location,
        district,
        landmark: z.string().nullable(),
        description: z.string().nullable(),
        facilities: z.array(facilityValue),
        status: statusPreview,
        lastVerifiedAt: z.iso.datetime(),
        photos: z.array(publishedPhoto),
      })
      .nullable()
      .describe("Data lokasi saat ini untuk perubahan dan kekurangan; kosong untuk laporan baru"),
    nearby: z.array(nearbyPlace).describe("Lokasi terbit bernama mirip dalam radius sekitar 50 m, untuk memeriksa duplikat"),
  })
  .describe("Laporan untuk diperiksa verifikator (FR-31)");

export const recheckList = z
  .object({
    total: z.number().int(),
    items: z.array(z.object({ id: z.uuid(), name: z.string(), category, district, status: z.enum(placeStatus.enumValues), lastVerifiedAt: z.iso.datetime() })),
  })
  .describe("Lokasi yang terakhir diverifikasi lebih dari 12 bulan lalu, terlama dulu (FR-38)");
