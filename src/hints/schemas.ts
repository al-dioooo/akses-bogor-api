// Skema jawaban petunjuk aksesibilitas (ADR-0052). Skema ini juga menjadi API spec (docs/openapi.json).
import { z } from "zod";

const provider = z.enum(["mapbox", "google"]);
const found = { result: z.literal("found"), placeName: z.string().describe("Nama tempat di penyedia"), distanceMeters: z.number().int().describe("Jarak dari titik tempat ini") };
const flag = z.boolean().nullable().describe("null: penyedia tidak tahu");

export const hintsResponse = z.object({
  hints: z
    .array(
      z.union([
        z.object({ provider: z.literal("mapbox"), ...found, wheelchairAccessible: z.boolean().describe("metadata.wheelchair_accessible dari Mapbox Search Box") }),
        z.object({
          provider: z.literal("google"),
          ...found,
          url: z.string().nullable().describe("Halaman tempat di Google Maps; wajib ditautkan bersama atribusi Google Maps"),
          accessibility: z.object({ entrance: flag, restroom: flag, parking: flag, seating: flag }).describe("accessibilityOptions Google Places API (New)"),
        }),
        z.object({ provider, result: z.enum(["none", "unavailable"]).describe("none: tidak ada tempat yang cocok atau tanpa tanda; unavailable: penyedia gagal atau batas harian habis") }),
      ]),
    )
    .describe("Satu baris per penyedia yang menyala; kosong bila petunjuk dimatikan"),
});

export const candidateHintParams = z.object({
  osmType: z.enum(["node", "way", "relation"]),
  osmId: z.coerce.number().int().positive(),
});
