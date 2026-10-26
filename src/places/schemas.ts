// Skema Zod untuk endpoint baca lokasi. Skema ini juga menjadi API spec (docs/openapi.json).
import { z } from "zod";
import { facilityAnswer, facilityKind, photoTag, placeCategory, placeStatus, unavailableReason } from "../db/schema.js";

const category = z.enum(placeCategory.enumValues);
const status = z.enum(placeStatus.enumValues);
const facility = z.enum(facilityKind.enumValues);

/** Nilai dipisah koma, mis. `category=kampus,masjid`. */
const csv = <T extends z.ZodType<unknown, string>>(item: T, description: string) =>
  z
    .string()
    .transform((value) => value.split(",").map((v) => v.trim()).filter(Boolean))
    .pipe(z.array(item).min(1).max(10))
    .optional()
    .describe(description);

export const placeFilters = z.object({
  q: z.string().trim().min(1).max(80).optional().describe("Cari nama tempat, cocok sebagian kata dan tanpa membedakan huruf besar"),
  category: csv(category, "Kategori, dipisah koma"),
  district: csv(z.string().max(40), "Slug kecamatan, dipisah koma, mis. bogor-tengah"),
  facility: csv(facility, "Fasilitas yang harus Tersedia, dipisah koma; semua harus terpenuhi"),
  status: csv(status, "Status, dipisah koma"),
});
export type PlaceFilters = z.infer<typeof placeFilters>;

export const listQuery = placeFilters.extend({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const mapQuery = placeFilters.extend({
  bbox: z
    .string()
    .transform((value) => value.split(",").map(Number))
    .pipe(
      z
        .tuple([z.number().min(-180).max(180), z.number().min(-90).max(90), z.number().min(-180).max(180), z.number().min(-90).max(90)])
        .refine(([west, south, east, north]) => west < east && south < north, "bbox harus barat,selatan,timur,utara"),
    )
    .optional()
    .describe("Batas tampilan peta: barat,selatan,timur,utara (derajat)"),
});

export const placeIdParams = z.object({ id: z.uuid() });

const district = z.object({ slug: z.string(), name: z.string() });
const location = z.object({ lat: z.number(), lng: z.number() });
const summary = z
  .object({
    available: z.number().int().describe("X: fasilitas relevan yang Tersedia"),
    relevant: z.number().int().describe("Y: fasilitas selain Tidak perlu"),
    unknown: z.number().int().describe("Fasilitas relevan yang Belum tahu"),
  })
  .describe("Ringkasan X dari Y fasilitas (ADR-0018)");
export const photo = z.object({
  id: z.uuid(),
  url: z.url().nullable().describe("Kosong bila PHOTO_PUBLIC_URL belum diatur"),
  alt: z.string(),
  caption: z.string().nullable(),
  tag: z.enum(photoTag.enumValues),
});

export const placeSummary = z.object({
  id: z.uuid(),
  name: z.string(),
  category,
  district,
  status,
  summary,
  location,
  lastVerifiedAt: z.iso.datetime(),
  coverPhoto: photo.nullable().describe("Foto tayang pertama, mendahulukan tag pintu_masuk"),
});

export const placeList = z.object({
  total: z.number().int().describe("Jumlah semua hasil yang cocok dengan filter"),
  limit: z.number().int(),
  offset: z.number().int(),
  items: z.array(placeSummary),
});

const facilityDetail = z.object({
  facility,
  answer: z.enum(facilityAnswer.enumValues),
  reason: z.enum(unavailableReason.enumValues).nullable(),
});

export const placeDetail = placeSummary.omit({ coverPhoto: true }).extend({
  landmark: z.string().nullable(),
  description: z.string().nullable(),
  facilities: z.array(facilityDetail.extend({ note: z.string().nullable() })).describe("Keempat fasilitas, urut ramp, toilet, guiding block, lift"),
  because: z.array(facilityDetail).describe("Fasilitas yang menentukan status, untuk kalimat alasan; kosong bila Aksesibel"),
  photos: z.array(photo).describe("Foto yang lolos moderasi, dikelompokkan menurut tag"),
  needsRecheck: z.boolean().describe("Terakhir diverifikasi lebih dari 12 bulan lalu (FR-38)"),
});

export const placeMap = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(
    z.object({
      type: z.literal("Feature"),
      id: z.uuid(),
      geometry: z.object({ type: z.literal("Point"), coordinates: z.tuple([z.number(), z.number()]).describe("[lng, lat]") }),
      properties: z.object({ name: z.string(), category, status }),
    }),
  ),
});

export const placeStats = z.object({
  places: z.number().int().describe("Lokasi yang sudah terbit"),
  byCategory: z.object({ kampus: z.number().int(), masjid: z.number().int(), halte: z.number().int(), rumah_sakit: z.number().int() }),
  stepFreeEntrance: z.number().int().describe("Lokasi dengan ramp Tersedia atau pintu masuk rata (Tidak perlu)"),
  contributors: z.number().int().describe("Pelapor berbeda yang laporannya sudah terbit"),
});

export const districtList = z.array(z.object({ slug: z.string(), name: z.string(), city: z.string(), places: z.number().int() }));
