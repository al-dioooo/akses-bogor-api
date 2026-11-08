// Skema Zod untuk route Laporkan (FR-20 sampai FR-27). Skema ini juga menjadi API spec (docs/openapi.json).
import { z } from "zod";
import { placeCategory, placeStatus } from "../db/schema.js";

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
