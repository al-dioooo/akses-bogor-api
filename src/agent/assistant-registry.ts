// Daftar alat asisten rute publik (ADR-0050): nama, deskripsi untuk model, skema input dan output, dan fungsinya. Hanya
// alat di daftar ini yang boleh dipanggil model asisten. Alat kontributor (OpenStreetMap, prioritas kecamatan) tidak
// ada di sini, dan tidak ada alat yang menerima atau mengembalikan koordinat atau rute.
import { z } from "zod";
import { placeCategory, placeStatus } from "../db/schema.js";
import { routeCardSchema } from "./cards.js";
import { findPlaceForAssistant, nearbyPlaces, placeAccessibilityForAssistant, showRoute } from "./assistant-tools.js";
import { AGENT_TOOLS } from "./registry.js";

export const placeId = z
  .union([z.uuid(), z.string().regex(/^osm:(node|way|relation)\/\d{1,15}$/)])
  .describe("Id dari find_place atau nearby_places: id lokasi AksesBogor, atau osm:<tipe>/<id> untuk kandidat OpenStreetMap");
const district = z.object({ slug: z.string(), name: z.string() });
const kecamatan = z.enum(["bogor-barat", "bogor-selatan", "bogor-tengah", "bogor-timur", "bogor-utara", "tanah-sareal"]);
const checked = {
  checkedByTeam: z.boolean().describe("Benar bila jawaban fasilitasnya sudah diperiksa tim AksesBogor"),
  verifiedBy: z.enum(["tim", "admin"]).describe("tim: diperiksa verifikator; admin: diterbitkan langsung oleh admin tanpa verifikator kedua"),
  source: z.string().describe("Asal data aksesibilitasnya"),
};
const placeItem = z.union([
  z.object({ id: z.uuid(), kind: z.literal("lokasi"), name: z.string(), category: z.enum(placeCategory.enumValues), status: z.enum(placeStatus.enumValues), district, ...checked }),
  z
    .object({ id: z.string(), kind: z.literal("kandidat"), name: z.string().nullable(), category: z.enum(placeCategory.enumValues), district, ...checked })
    .describe("Kandidat OpenStreetMap tanpa status dan tanpa data aksesibilitas dari tim"),
]);

const findPlaceTool = {
  name: "find_place",
  description:
    "Mencari tempat menurut nama atau sebagian nama, kategori, atau kecamatan: lokasi AksesBogor (kind lokasi, paling banyak 5) dan kandidat OpenStreetMap yang belum punya data aksesibilitas dari tim (kind kandidat, id osm:<tipe>/<id>, paling banyak 5). Keduanya bisa menjadi tujuan show_route. Bila tidak ada hasil, katakan tempat itu belum tercatat di AksesBogor.",
  input: z
    .object({
      query: z.string().trim().min(2).max(100).optional().describe('Nama tempat atau sebagian namanya, mis. "RSUD"'),
      category: z.enum(placeCategory.enumValues).optional().describe("kampus, masjid, halte, atau rumah_sakit"),
      kecamatan: kecamatan.optional().describe("Slug kecamatan, mis. bogor-tengah"),
    })
    .refine((v) => v.query !== undefined || v.category !== undefined || v.kecamatan !== undefined, { message: "Isi query, category, atau kecamatan" }),
  output: z.object({ places: z.array(placeItem), catatan: z.string().optional() }),
  run: findPlaceForAssistant,
};

const contributorAccessibility = AGENT_TOOLS.find((tool) => tool.name === "place_accessibility")!;

const placeAccessibilityTool = {
  name: "place_accessibility",
  description:
    "Status aksesibilitas sebuah lokasi, jawaban keempat fasilitas (ramp, toilet difabel, guiding block, lift) dengan alasan dan catatan, tanggal verifikasi terakhir, apakah tim AksesBogor sudah memeriksanya (checkedByTeam), dan sumbernya. Sampaikan apa adanya: belum_tahu berarti belum diketahui, bukan tidak tersedia. Bila checkedByTeam salah, sebut tempat itu belum diperiksa tim. Untuk kandidat OpenStreetMap hasilnya tanpa status dan tanpa fasilitas.",
  input: z.object({ placeId }),
  output: z.union([
    contributorAccessibility.output.extend({ kind: z.literal("lokasi"), ...checked }),
    z.object({ id: z.string(), kind: z.literal("kandidat"), name: z.string().nullable(), category: z.enum(placeCategory.enumValues), district, ...checked, facilities: z.array(z.never()), catatan: z.string() }),
  ]),
  run: placeAccessibilityForAssistant,
};

const knowledgeTool = AGENT_TOOLS.find((tool) => tool.name === "search_knowledge")!;

const nearbyTool = {
  name: "nearby_places",
  description:
    "Lokasi AksesBogor dan kandidat OpenStreetMap terdekat dari titik awal pengunjung, paling banyak 5 dan paling jauh 10 km, dengan jarak garis lurus yang dibulatkan ke 100 m. Anda tidak menerima posisi pengunjung atau koordinat tempat. Jarak ini bukan jarak jalan kaki. Bila titik awal belum ada, hasilnya galat posisi_belum_ada.",
  input: z.object({
    category: z.enum(placeCategory.enumValues).optional().describe("kampus, masjid, halte, atau rumah_sakit"),
    status: z.array(z.enum(placeStatus.enumValues)).min(1).max(4).optional().describe("Batasi ke status tertentu, mis. [\"aksesibel\"]"),
    limit: z.number().int().min(1).max(5).optional().describe("Jumlah tempat, bawaan 5"),
  }),
  output: z.object({
    places: z.array(z.intersection(placeItem, z.object({ distanceMeters: z.number().int().describe("Jarak garis lurus, dibulatkan ke 100 m") }))),
    catatan: z.string().optional(),
    note: z.string(),
  }),
  run: nearbyPlaces,
};

const showRouteTool = {
  name: "show_route",
  description:
    "Menampilkan kartu rute jalan kaki ke sebuah lokasi AksesBogor atau kandidat OpenStreetMap di layar pengunjung. Aplikasi menghitung rutenya sendiri dari titik awal pengunjung, dengan peringatan tetap dan hambatan yang tercatat; Anda tidak menerima rute itu dan tidak boleh menilainya. Hasilnya hanya konfirmasi.",
  input: z.object({ placeId }),
  output: z.object({ pesan: z.string(), kartu: routeCardSchema }),
  run: showRoute,
};

export const ASSISTANT_TOOLS = [findPlaceTool, placeAccessibilityTool, knowledgeTool, nearbyTool, showRouteTool] as const;
