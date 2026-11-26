// Skema jawaban petunjuk aksesibilitas (ADR-0052). Skema ini juga menjadi API spec (docs/openapi.json).
import { z } from "zod";
import { OSM_WHEELCHAIR } from "./stored.js";

const provider = z.enum(["mapbox", "google"]);
const found = { result: z.literal("found"), placeName: z.string().describe("Nama tempat di penyedia"), distanceMeters: z.number().int().describe("Jarak dari titik tempat ini") };
const flag = z.boolean().nullable().describe("null: penyedia tidak tahu");
const googleUrl = z.string().nullable().describe("Halaman tempat di Google Maps; wajib ditautkan bersama atribusi Google Maps");
const flags = z.object({ entrance: flag, restroom: flag, parking: flag, seating: flag });

const liveHint = z.union([
  z.object({ provider: z.literal("mapbox"), ...found, wheelchairAccessible: z.boolean().describe("metadata.wheelchair_accessible dari Mapbox Search Box") }),
  z.object({ provider: z.literal("google"), ...found, url: googleUrl, accessibility: flags.describe("accessibilityOptions Google Places API (New)") }),
  z.object({ provider, result: z.enum(["none", "unavailable"]).describe("none: tidak ada tempat yang cocok atau tanpa tanda; unavailable: penyedia gagal atau batas harian habis") }),
]);

/** Salinan tersimpan di baris kandidat OSM (tag `aksesbogor:google_maps` dan `aksesbogor:osm_aksesibilitas`). */
const storedHint = z.union([
  z.object({
    provider: z.literal("google"),
    result: z.literal("stored"),
    placeName: z.string().nullable().describe("Nama tempat di Google Maps saat diambil"),
    distanceMeters: z.number().int().nullable().describe("Jarak tempat Google Maps dari titik OSM saat diambil"),
    url: googleUrl,
    retrievedAt: z.iso.date().describe("Tanggal salinan diambil (WIB)"),
    accessibility: flags.describe("Opsi aksesibilitas Google Maps saat diambil"),
  }),
  z.object({
    provider: z.literal("openstreetmap"),
    result: z.literal("stored"),
    wheelchair: z.enum(OSM_WHEELCHAIR).describe("Nilai wheelchair OSM yang tersimpan, bila berbeda dari tag tempat itu sendiri"),
  }),
]);

export const hintsResponse = z.object({
  hints: z.array(liveHint).describe("Satu baris per penyedia yang menyala; kosong bila petunjuk dimatikan"),
});

export const candidateHintsResponse = z.object({
  hints: z
    .array(z.union([...liveHint.options, ...storedHint.options]))
    .describe("Satu baris per penyedia yang menyala, lalu salinan tersimpan (result `stored`) bila ada; kosong bila petunjuk dimatikan"),
});

export const candidateHintParams = z.object({
  osmType: z.enum(["node", "way", "relation"]),
  osmId: z.coerce.number().int().positive(),
});

const tally = z.object({ withData: z.number().int().min(0), accessible: z.number().int().min(0) });
/** Jawaban GET /districts/accessibility (ADR-0053). */
export const districtAccessibilityResponse = z.object({
  minimumPlaces: z.number().int().describe("Kecamatan dengan tempat ber-keterangan kurang dari ini tidak diberi skor"),
  formula: z.string(),
  caveat: z.string().describe("Kalimat yang wajib ikut skor: keterangan pihak ketiga belum diperiksa tim"),
  districts: z.array(
    z.object({
      slug: z.string(),
      name: z.string(),
      places: z.number().int().describe("Lokasi AksesBogor terbit ditambah kandidat OSM tanpa data AksesBogor"),
      withData: z.number().int().describe("Tempat yang punya keterangan pintu masuk dari salah satu sumber"),
      accessible: z.number().int().describe("Pintu masuknya bisa dimasuki kursi roda"),
      limited: z.number().int().describe("OSM `wheelchair=limited`: ber-keterangan, tetapi tidak dihitung bisa dimasuki"),
      notAccessible: z.number().int(),
      score: z.number().int().min(0).max(100).nullable().describe("null: data belum cukup"),
      rank: z.number().int().min(1).nullable(),
      bySource: z
        .object({ aksesbogor: tally, openstreetmap: tally, google_maps: tally })
        .describe("Rincian per sumber. Hanya `aksesbogor` yang diperiksa tim; sisanya selalu ditampilkan sebagai belum diperiksa tim"),
    }),
  ),
  sources: z.object({
    aksesbogor: z.object({ checkedByTeam: z.literal(true) }),
    openstreetmap: z.object({ checkedByTeam: z.literal(false), attribution: z.string(), url: z.url(), retrievedAt: z.iso.datetime().nullable() }),
    google_maps: z
      .object({ checkedByTeam: z.literal(false), attribution: z.string(), retrievedAt: z.iso.date().nullable().describe("Tanggal (WIB) salinan terbaru yang dihitung") })
      .nullable()
      .describe("null selama petunjuk mati: Google Maps tidak dihitung"),
  }),
});
