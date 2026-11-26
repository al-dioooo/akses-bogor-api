// Profil Agen AI untuk akun yang sudah lengkap (ADR-0054): alat asisten rute publik (ADR-0050) ditambah alat
// kontributor dari agen Bantu memetakan (ADR-0043). Semua alat di sini memakai id tempat yang sama dengan asisten,
// yaitu id lokasi AksesBogor atau `osm:<tipe>/<id>`, jadi tempat dari find_places_to_contribute bisa langsung menjadi
// tujuan show_route dan show_place_card. Seperti alat lain, tidak ada yang menerima atau mengembalikan koordinat.
import { z } from "zod";
import { placeCategory } from "../db/schema.js";
import type { AgentProfile } from "./ask.js";
import { ASSISTANT_TOOLS, placeId } from "./assistant-registry.js";
import { assistantPrompt, guardAssistantAnswer } from "./assistant-prompt.js";
import { candidateId, parseCandidateId } from "./assistant-tools.js";
import { placeCardSchema, showPlaceCard } from "./cards.js";
import type { ChosenPlace } from "./prompt.js";
import { AGENT_TOOLS, type RegisteredTool } from "./registry.js";
import { findPlacesToContribute, type ToolContext } from "./tools.js";

const contributorTool = (name: string) => AGENT_TOOLS.find((tool) => tool.name === name)!;
const contribute = contributorTool("find_places_to_contribute");

const contributeTool = {
  name: "find_places_to_contribute",
  description:
    "Mencari tempat umum di Kota Bogor (kampus, masjid, halte, rumah sakit) dari OpenStreetMap yang belum punya data AksesBogor, untuk didatangi dan dipetakan penanya. Urut menurut prioritas kecamatan. Bisa dibatasi kecamatan dan kategori. Setiap tempat punya id osm:<tipe>/<id> untuk show_place_card dan show_route. Data © kontributor OpenStreetMap; sebut atribusinya.",
  input: contribute.input,
  output: z.object({
    places: z.array(
      z.object({
        id: z.string().describe("osm:<tipe>/<id>, untuk show_place_card dan show_route"),
        name: z.string().nullable(),
        category: z.enum(placeCategory.enumValues),
        district: z.object({ slug: z.string(), name: z.string() }),
        priorityRank: z.number().int().nullable().describe("Peringkat prioritas kecamatannya, atau null bila prioritas belum dibuka"),
      }),
    ),
    order: z.enum(["prioritas_kecamatan", "tempat_tanpa_data_terbanyak"]),
    attribution: z.string(),
  }),
  run: async (ctx: ToolContext, input: Parameters<typeof findPlacesToContribute>[1]) => {
    const found = await findPlacesToContribute(ctx, input);
    return { ...found, places: found.places.map(({ osm, ...place }) => ({ id: candidateId(osm), ...place })) };
  },
};

const placeCardTool = {
  name: "show_place_card",
  description:
    "Menampilkan kartu sebuah tempat di layar penanya: lokasi AksesBogor, atau tempat OpenStreetMap tanpa data AksesBogor beserta tautan Laporkan. Pakai id dari find_place, nearby_places, atau find_places_to_contribute. Hasilnya hanya konfirmasi; isi kartu tidak dikirim kepada Anda.",
  input: z.object({ placeId }),
  output: z.object({ pesan: z.string(), kartu: placeCardSchema }),
  run: (ctx: ToolContext, input: { placeId: string }) => {
    const osm = parseCandidateId(input.placeId);
    return showPlaceCard(ctx, osm ? { osmType: osm.osmType as "node" | "way" | "relation", osmId: osm.osmId } : { placeId: input.placeId });
  },
};

export const CONTRIBUTOR_ASSISTANT_TOOLS: readonly RegisteredTool[] = [...ASSISTANT_TOOLS, contributeTool, contributorTool("kecamatan_priority"), placeCardTool];

/** Instruksi asisten rute publik, ditambah aturan kontributor dari ADR-0043 untuk akun yang sudah lengkap. */
export function contributorAssistantPrompt(place?: ChosenPlace, ctx?: ToolContext): string {
  return `${assistantPrompt(place, ctx)}

Penanya ini masuk dengan akun AksesBogor, jadi Anda juga membantunya memetakan: mendatangi tempat umum yang belum punya data, memeriksa fasilitasnya, dan mengirim laporan lewat menu Laporkan. Aturan tambahan:
15. Untuk mencari tempat yang perlu dipetakan, pakai find_places_to_contribute, lalu tampilkan tempat yang Anda sarankan dengan show_place_card supaya penanya bisa langsung melaporkannya. Sebut "© kontributor OpenStreetMap".
16. Untuk kecamatan mana yang diprioritaskan, pakai kecamatan_priority. Setiap kali menyebut jumlah penyandang disabilitas, sampaikan bahwa itu jumlah yang terdaftar di Dinas Sosial, bukan seluruh penduduk, dan sebut sumbernya. Bila alat itu menjawab galat, katakan prioritas kecamatan belum tersedia dan pakai find_places_to_contribute saja.
17. Pertanyaan tentang cara memetakan, melapor, dan aturan bukti AksesBogor termasuk yang bisa Anda bantu; jawab dari search_knowledge.`;
}

export const CONTRIBUTOR_ASSISTANT_PROFILE: AgentProfile = { tools: CONTRIBUTOR_ASSISTANT_TOOLS, system: contributorAssistantPrompt, guard: guardAssistantAnswer };
