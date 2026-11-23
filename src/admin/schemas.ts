// Skema Zod untuk route kelola tempat oleh admin (ADR-0051). Skema ini juga menjadi API spec (docs/openapi.json).
import { z } from "zod";
import { facilityAnswer, facilityKind, placeCategory, placeStatus, unavailableReason } from "../db/schema.js";
import { photo } from "../places/schemas.js";
import { facilityInput, line, paragraph, photoInput, point } from "../reports/schemas.js";

const category = z.enum(placeCategory.enumValues);
const status = z.enum(placeStatus.enumValues);
const district = z.object({ slug: z.string(), name: z.string() });
const location = z.object({ lat: z.number(), lng: z.number() });

export const adminPlaceQuery = z.object({
  q: z.string().trim().min(1).max(80).optional().describe("Cari nama tempat, cocok sebagian kata"),
  category: category.optional(),
  district: z.string().max(40).optional().describe("Slug kecamatan"),
  status: status.optional(),
  origin: z.enum(["tim", "admin"]).optional().describe("`tim`: terakhir diterbitkan verifikator. `admin`: dibuat, diubah, atau diterbitkan langsung oleh admin"),
  published: z.enum(["ya", "tidak"]).optional().describe("`ya`: masih tayang. `tidak`: diturunkan. Kosong: semua"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});
export type AdminPlaceQuery = z.infer<typeof adminPlaceQuery>;

export const adminPlaceItem = z.object({
  id: z.uuid(),
  name: z.string(),
  category,
  district,
  status,
  summary: z.object({ available: z.number().int(), relevant: z.number().int(), unknown: z.number().int() }),
  verifiedBy: z.enum(["tim", "admin"]),
  lastVerifiedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  published: z.boolean(),
  unpublishedAt: z.iso.datetime().nullable(),
  unpublishedReason: z.string().nullable(),
});

export const adminPlaceList = z.object({
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
  items: z.array(adminPlaceItem),
});

export const adminFacility = z.object({
  facility: z.enum(facilityKind.enumValues),
  answer: z.enum(facilityAnswer.enumValues),
  reason: z.enum(unavailableReason.enumValues).nullable(),
  note: z.string().nullable(),
});

export const adminPlaceDetail = adminPlaceItem.extend({
  version: z.iso.datetime().describe("Kirim kembali di `PATCH` supaya perubahan orang lain tidak tertimpa"),
  location,
  landmark: z.string().nullable(),
  description: z.string().nullable(),
  facilities: z.array(adminFacility),
  photos: z.array(photo).describe("Foto yang tayang"),
  adminPublishedBy: z.string().nullable().describe("Nama tampilan admin yang terakhir menerbitkan langsung; tidak pernah tampil untuk publik"),
});

export const placeHistory = z.object({
  items: z.array(
    z.object({
      id: z.number().int(),
      action: z.string().describe("Mis. dibuat, diubah, dibuat_admin, diubah_admin, diturunkan, ditayangkan_lagi, terbit_langsung"),
      actor: z.object({
        name: z.string().nullable().describe("Nama tampilan anggota tim; kosong untuk sistem, skrip, atau akun yang sudah dihapus"),
        label: z.enum(["sistem", "skrip"]).nullable(),
      }),
      at: z.iso.datetime(),
      changes: z.record(z.string(), z.unknown()).nullable().describe("Perbedaan `{ kolom: { sebelum, sesudah } }`, `alasan`, dan id laporan bila ada"),
    }),
  ),
});

export const candidateQuery = z.object({
  q: z.string().trim().min(1).max(80).optional(),
  category: category.optional(),
  district: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export const candidateList = z.object({
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
  items: z.array(
    z.object({
      osmType: z.string(),
      osmId: z.number().int(),
      name: z.string().nullable(),
      category,
      district,
      location,
      wheelchair: z.string().nullable().describe("Tag `wheelchair` OSM apa adanya; bukan status AksesBogor"),
    }),
  ),
  attribution: z.string(),
});

/** Alasan admin untuk setiap tindakan, masuk log audit (ADR-0051). Boleh beberapa baris, tanpa karakter kontrol lain. */
const reason = z
  .string()
  .trim()
  .min(5)
  .max(500)
  .regex(/^(?:[^\p{C}]|[\n\r\t])+$/u)
  .describe("Alasan tindakan, 5 sampai 500 karakter; masuk log audit, tidak tampil untuk publik");

export const adminPlaceBody = z.object({
  name: line(120),
  category,
  location: point,
  landmark: line(140).nullable().optional(),
  description: paragraph(1000).nullable().optional(),
  facilities: z
    .array(facilityInput)
    .length(4)
    .refine((items) => new Set(items.map((f) => f.facility)).size === 4, "Setiap fasilitas dijawab tepat sekali")
    .describe("Keempat jawaban. Tersedia dan Tidak perlu tanpa foto bertag fasilitas itu disimpan sebagai Belum tahu"),
  photos: z
    .array(photoInput)
    .max(10)
    .default([])
    .refine((items) => new Set(items.map((p) => p.id)).size === items.length, "Foto tidak boleh dobel")
    .describe("Foto baru dari `POST /reports/photos` milik akun ini; tayang tanpa penyunting kaburkan"),
  reason,
  osm: z
    .object({ type: z.enum(["node", "way", "relation"]), id: z.number().int().positive() })
    .optional()
    .describe("Kandidat OpenStreetMap asal tempat baru, dicatat di log audit (ADR-0049)"),
});

export const adminPlaceUpdateBody = adminPlaceBody.omit({ osm: true }).extend({
  version: z.iso.datetime().describe("`version` dari `GET /admin/places/{id}`"),
  removePhotos: z.array(z.uuid()).max(20).default([]).describe("Id foto tayang tempat ini yang dihapus"),
});

export const reasonBody = z.object({ reason });

export const saveResult = z.object({
  placeId: z.uuid(),
  status,
  downgraded: z.array(z.enum(facilityKind.enumValues)).describe("Fasilitas yang dijawab Tersedia atau Tidak perlu tanpa foto, jadi disimpan sebagai Belum tahu"),
});
