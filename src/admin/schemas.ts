// Skema Zod untuk route kelola tempat oleh admin (ADR-0051). Skema ini juga menjadi API spec (docs/openapi.json).
import { z } from "zod";
import { facilityAnswer, facilityKind, placeCategory, placeStatus, unavailableReason } from "../db/schema.js";
import { photo } from "../places/schemas.js";

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
