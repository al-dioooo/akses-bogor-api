// Daftar alat untuk model agen rute (ADR-0042) di satu tempat: nama, deskripsi untuk model, skema input dan output, dan
// fungsinya. Route API dan adapter model memakai daftar yang sama; larik `tools` format OpenAI dibuat dari skema Zod.
// Hanya tiga alat ini yang boleh dipanggil model. Rute jalan kaki dan hambatan di rute tidak pernah menjadi alat.
import { z } from "zod";
import { knowledgeKind, placeCategory, placeStatus } from "../db/schema.js";
import { HttpError } from "../http/errors.js";
import { placeDetail } from "../places/schemas.js";
import { findPlace, placeAccessibility, searchKnowledgeTool, type ToolContext } from "./tools.js";

const location = z.object({ lat: z.number(), lng: z.number() });
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
  output: placeDetail.omit({ photos: true, location: true }),
  run: placeAccessibility,
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

export const AGENT_TOOLS = [findPlaceTool, placeAccessibilityTool, knowledgeTool] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number];
export type ToolName = AgentTool["name"];

/** Satu alat dalam larik `tools` format OpenAI chat completions, yang juga dipakai OpenRouter. */
export type ToolDefinition = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

/** Larik `tools` untuk penyedia model yang mendukung tool calling: nama, deskripsi, dan JSON Schema parameter. */
export function toolDefinitions(): ToolDefinition[] {
  return AGENT_TOOLS.map((tool) => {
    // `$schema` dibuang: penyedia model hanya meminta objek skemanya.
    const parameters = z.toJSONSchema(tool.input, { io: "input" }) as Record<string, unknown>;
    delete parameters.$schema;
    return { type: "function", function: { name: tool.name, description: tool.description, parameters } };
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
