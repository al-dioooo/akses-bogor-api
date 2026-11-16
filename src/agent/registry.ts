// Daftar alat agen rute (ADR-0042) di satu tempat: nama, deskripsi untuk model, skema input dan output, dan fungsinya.
// Route API dan penyedia model mana pun nanti memakai daftar yang sama; definisi untuk model dibuat dari skema Zod.
import { z } from "zod";
import { knowledgeKind, osmFeatureKind, placeCategory, placeStatus } from "../db/schema.js";
import { HttpError } from "../http/errors.js";
import { placeDetail } from "../places/schemas.js";
import { findPlace, placeAccessibility, routeObstacles, searchKnowledgeTool, walkingRoute, type ToolContext } from "./tools.js";

const location = z.object({ lat: z.number(), lng: z.number() });
const position = z
  .object({ lat: z.number().min(-90).max(90).describe("Lintang (derajat, WGS 84)"), lng: z.number().min(-180).max(180).describe("Bujur (derajat, WGS 84)") })
  .describe("Posisi pengguna saat ini");
const placeId = z.uuid().describe("Id lokasi AksesBogor dari find_place");

const findPlaceTool = {
  name: "find_place",
  description:
    "Mencari tempat di database AksesBogor menurut nama atau sebagian nama, paling banyak 5. Hanya tempat di database ini yang bisa menjadi tujuan. Bila tidak ada hasil, katakan tempat itu belum tercatat di AksesBogor.",
  input: z.object({ query: z.string().trim().min(2).max(100).describe('Nama tempat atau sebagian namanya, mis. "masjid raya"') }),
  output: z.object({
    places: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        category: z.enum(placeCategory.enumValues),
        status: z.enum(placeStatus.enumValues),
        district: z.object({ slug: z.string(), name: z.string() }),
        location,
      }),
    ),
  }),
  run: findPlace,
};

const placeAccessibilityTool = {
  name: "place_accessibility",
  description:
    "Status aksesibilitas sebuah tempat dan jawaban keempat fasilitas (ramp, toilet difabel, guiding block, lift) yang sudah diverifikasi, dengan alasan, catatan, dan tanggal verifikasi terakhir. Sampaikan jawaban apa adanya: belum_tahu berarti belum diketahui, bukan tidak tersedia, dan jangan ditebak dari sumber lain.",
  input: z.object({ placeId }),
  output: placeDetail.omit({ photos: true }),
  run: placeAccessibility,
};

const walkingRouteTool = {
  name: "walking_route",
  description:
    "Rute jalan kaki dari posisi pengguna ke pin tempat tujuan (biasanya pintu masuk utama): jarak, waktu, langkah, dan garis rute. Rute ini dari profil jalan kaki Mapbox yang tidak memperhitungkan tangga, kerb, atau kemiringan; jangan pernah menyebutnya aksesibel atau ramah kursi roda, dan selalu sampaikan isi `warning`.",
  input: z.object({ from: position, placeId }),
  output: z.object({
    destination: z.object({ placeId: z.uuid(), name: z.string(), location }),
    distanceMeters: z.number().int(),
    durationSeconds: z.number().int(),
    steps: z.array(
      z.object({ instruction: z.string(), distanceMeters: z.number().int(), durationSeconds: z.number().int(), name: z.string().nullable(), maneuver: z.string(), location }),
    ),
    geometry: z.object({ type: z.literal("LineString"), coordinates: z.array(z.tuple([z.number(), z.number()])) }).describe("GeoJSON [bujur, lintang]"),
    polyline: z.string().describe("Garis rute sebagai polyline presisi 6, untuk route_obstacles"),
    warning: z.string(),
    attribution: z.string(),
  }),
  run: walkingRoute,
};

const routeObstaclesTool = {
  name: "route_obstacles",
  description:
    "Fitur OpenStreetMap di dekat garis rute yang penting untuk kursi roda dan tunanetra: tangga, kerb, ramp, lift, pintu masuk, dan guiding block, urut dari awal rute. Sebut sebagai data OpenStreetMap yang bisa tidak lengkap; daftar kosong bukan berarti jalannya bebas hambatan.",
  input: z.object({
    polyline: z.string().min(2).max(60_000).describe("Nilai `polyline` dari hasil walking_route"),
    bufferMeters: z.number().int().min(5).max(50).optional().describe("Jarak paling jauh dari garis rute, dalam meter; bawaan 20"),
  }),
  output: z.object({
    bufferMeters: z.number().int(),
    truncated: z.boolean().describe("Benar bila lebih dari 50 fitur cocok dan hanya 50 pertama yang dikirim"),
    features: z.array(
      z.object({
        kind: z.enum(osmFeatureKind.enumValues),
        description: z.string(),
        name: z.string().nullable(),
        tags: z.record(z.string(), z.string()),
        distanceFromRouteMeters: z.number().int(),
        alongRouteMeters: z.number().int().describe("Jarak dari awal rute ke titik terdekat dengan fitur ini"),
        osm: z.object({ type: z.string(), id: z.number().int(), url: z.url() }),
      }),
    ),
    note: z.string(),
    attribution: z.string(),
  }),
  run: routeObstacles,
};

const knowledgeTool = {
  name: "search_knowledge",
  description:
    "Mencari potongan teks di basis pengetahuan: UU No. 8 Tahun 2016, Permen PUPR No. 14/PRT/M/2017 beserta lampiran teknisnya, aturan dan halaman edukasi AksesBogor, serta rute bus dan angkot Kota Bogor dari OpenStreetMap. Setiap potongan membawa sitasi dan lisensinya; kutip sitasinya bila memakai isinya.",
  input: z.object({
    query: z.string().trim().min(2).max(300).describe("Pertanyaan atau kata kunci dalam bahasa Indonesia"),
    kinds: z.array(z.enum(knowledgeKind.enumValues)).max(4).optional().describe("Batasi ke jenis sumber tertentu"),
    limit: z.number().int().min(1).max(8).optional().describe("Jumlah potongan, bawaan 5"),
  }),
  output: z.object({
    passages: z.array(
      z.object({
        citation: z.string(),
        heading: z.string().nullable(),
        text: z.string(),
        source: z.object({
          id: z.string(),
          kind: z.enum(knowledgeKind.enumValues),
          title: z.string(),
          url: z.url(),
          license: z.string(),
          attribution: z.string().nullable(),
          retrievedAt: z.iso.datetime(),
        }),
        score: z.number(),
      }),
    ),
  }),
  run: searchKnowledgeTool,
};

export const AGENT_TOOLS = [findPlaceTool, placeAccessibilityTool, walkingRouteTool, routeObstaclesTool, knowledgeTool] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number];
export type ToolName = AgentTool["name"];

export type ToolDefinition = { name: string; description: string; inputSchema: Record<string, unknown> };

/** Definisi alat untuk penyedia model yang mendukung tool calling: nama, deskripsi, dan JSON Schema input. */
export function toolDefinitions(): ToolDefinition[] {
  return AGENT_TOOLS.map((tool) => {
    // `$schema` dibuang: penyedia model hanya meminta objek skemanya.
    const inputSchema = z.toJSONSchema(tool.input, { io: "input" }) as Record<string, unknown>;
    delete inputSchema.$schema;
    return { name: tool.name, description: tool.description, inputSchema };
  });
}

/**
 * Menjalankan satu alat dari nama dan input mentah, mis. dari panggilan alat sebuah model. Input diperiksa dengan skema
 * yang sama dengan route API; galat dikembalikan sebagai HttpError dengan kode dan pesan yang bisa diteruskan ke model.
 */
export async function runTool(ctx: ToolContext, name: string, input: unknown): Promise<unknown> {
  const tool = AGENT_TOOLS.find((t) => t.name === name);
  if (!tool) throw new HttpError(404, "alat_tidak_dikenal", `Alat ${name} tidak dikenal.`);
  const parsed = tool.input.safeParse(input);
  if (!parsed.success) throw new HttpError(400, "input_tidak_valid", `Input ${name} tidak sesuai skema.`);
  return (tool.run as (ctx: ToolContext, input: unknown) => Promise<unknown>)(ctx, parsed.data);
}
