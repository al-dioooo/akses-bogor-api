// Daftar alat untuk model agen rute (ADR-0042) di satu tempat: nama, deskripsi untuk model, skema input dan output, dan
// fungsinya. Route API dan adapter model memakai daftar yang sama; larik `tools` format OpenAI dibuat dari skema Zod.
// Hanya alat di daftar ini yang boleh dipanggil model. Rute jalan kaki dan hambatan di rute tidak pernah menjadi alat.
import { z } from "zod";
import { knowledgeKind, placeCategory, placeStatus } from "../db/schema.js";
import { HttpError } from "../http/errors.js";
import { placeDetail } from "../places/schemas.js";
import { prioritySchema } from "../routes/districts.js";
import { cardInput, placeCardSchema, routeCardSchema, showPlaceCard, showRouteCard } from "./cards.js";
import { findPlace, findPlacesToContribute, kecamatanPriorityTool, placeAccessibility, searchKnowledgeTool, type ToolContext } from "./tools.js";

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

const kecamatan = z.enum(["bogor-barat", "bogor-selatan", "bogor-tengah", "bogor-timur", "bogor-utara", "tanah-sareal"]);

const contributeTool = {
  name: "find_places_to_contribute",
  description:
    "Mencari tempat umum di Kota Bogor (kampus, masjid, halte, rumah sakit) dari OpenStreetMap yang belum punya data AksesBogor, untuk didatangi dan dipetakan kontributor. Urut menurut prioritas kecamatan. Bisa dibatasi kecamatan dan kategori. Data © kontributor OpenStreetMap; sebut atribusinya.",
  input: z.object({
    kecamatan: kecamatan.optional().describe("Slug kecamatan, mis. bogor-barat"),
    category: z.enum(placeCategory.enumValues).optional().describe("kampus, masjid, halte, atau rumah_sakit"),
    limit: z.number().int().min(1).max(10).optional().describe("Jumlah tempat, bawaan 5"),
  }),
  output: z.object({
    places: z.array(
      z.object({
        osm: z.object({ osmType: z.string(), osmId: z.number().int() }).describe("Pengenal tempat untuk show_place_card dan show_route_card"),
        name: z.string().nullable(),
        category: z.enum(placeCategory.enumValues),
        district: z.object({ slug: z.string(), name: z.string() }),
        priorityRank: z.number().int().nullable().describe("Peringkat prioritas kecamatannya, atau null bila prioritas belum dibuka"),
      }),
    ),
    order: z.enum(["prioritas_kecamatan", "tempat_tanpa_data_terbanyak"]),
    attribution: z.string(),
  }),
  run: findPlacesToContribute,
};

const priorityTool = {
  name: "kecamatan_priority",
  description:
    "Prioritas keenam kecamatan untuk kontributor: jumlah penyandang disabilitas terdaftar di Dinas Sosial (tahun terbaru), lokasi AksesBogor, tempat tanpa data, skor 0–100, dan peringkat. Selalu sampaikan `caveat` bila menyebut angka disabilitas, dan sebut sumbernya (Open Data Kota Bogor, Dinas Sosial). Jangan memakai kata \"cacat\"; pakai disabilitas fisik, netra, mental, atau lainnya.",
  input: z.object({}),
  output: prioritySchema,
  run: kecamatanPriorityTool,
};

const placeCardTool = {
  name: "show_place_card",
  description:
    "Menampilkan kartu sebuah tempat di layar pengguna: lokasi AksesBogor (placeId dari find_place) atau tempat OpenStreetMap (osmType dan osmId dari find_places_to_contribute). Hasilnya hanya konfirmasi; isi kartu tidak dikirim kepada Anda.",
  input: cardInput,
  output: z.object({ pesan: z.string(), kartu: placeCardSchema }),
  run: showPlaceCard,
};

const routeCardTool = {
  name: "show_route_card",
  description:
    "Menampilkan kartu rute jalan kaki ke sebuah tempat di layar pengguna. Aplikasi menghitung rutenya sendiri dari posisi pengguna, dengan peringatan tetap; Anda tidak menerima rute itu dan tidak boleh menilai rutenya. Input sama dengan show_place_card. Hasilnya hanya konfirmasi.",
  input: cardInput,
  output: z.object({ pesan: z.string(), kartu: routeCardSchema }),
  run: showRouteCard,
};

export const AGENT_TOOLS = [findPlaceTool, placeAccessibilityTool, knowledgeTool, contributeTool, priorityTool, placeCardTool, routeCardTool] as const;
/** Alat yang hanya menampilkan kartu di web; model menerima `pesan`-nya saja. */
export const CARD_TOOLS: ReadonlySet<string> = new Set([placeCardTool.name, routeCardTool.name]);
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
