// Satu pertanyaan ke agen rute (ADR-0043): putaran alat yang dibatasi, argumen alat diperiksa skema Zod, dan sumber
// dikumpulkan dari hasil alat. Tidak ada yang disimpan; percakapan hanya hidup selama permintaan ini.
import { HttpError } from "../http/errors.js";
import type { KnowledgeHit } from "../knowledge/search.js";
import type { AgentMessage, AgentModel, ToolCall } from "./model.js";
import { guardRouteClaims, systemPrompt, type ChosenPlace } from "./prompt.js";
import type { KecamatanPriority } from "../contribute/priority.js";
import type { PlaceCard, RouteCard } from "./cards.js";
import { AGENT_TOOLS, CARD_TOOLS, runTool, toolDefinitions, type RegisteredTool } from "./registry.js";
import type { ToolContext } from "./tools.js";

/** Putaran alat paling banyak; langkah setelahnya meminta model menjawab tanpa alat. */
export const MAX_TOOL_ROUNDS = 3;
/** Panggilan alat paling banyak per putaran; sisanya dijawab galat tanpa dijalankan. */
export const MAX_CALLS_PER_ROUND = 4;
/** Tenggat satu pertanyaan, termasuk semua permintaan ke model. */
export const QUESTION_DEADLINE_MS = 60_000;

/** Jawaban yang menyebut peraturan. Bila belum ada hasil search_knowledge, server mencarikannya dan meminta jawaban ulang. */
const CITES_REGULATION = /\b(permen|peraturan|undang-undang|uu no|pasal \d+|lampiran [ivx]+)\b/i;

/** Dikirim bila model masih meminta alat setelah putaran terakhir. */
export const NO_ANSWER =
  "Maaf, agen belum bisa menjawab pertanyaan ini. Coba tanyakan dengan kalimat yang lebih singkat, atau lihat Detail lokasi untuk data fasilitasnya.";

export type Turn = { role: "user" | "assistant"; content: string };
export type Source =
  | { type: "lokasi"; placeId: string; name: string; lastVerifiedAt: string; verifiedBy: "tim" | "admin" }
  | { type: "pengetahuan"; citation: string; title: string; url: string; license: string; attribution: string | null };
/** Kartu untuk web: tempat, rute (dihitung web dari posisi pengguna), atau prioritas kecamatan. Tidak pernah ke model. */
export type Card = PlaceCard | RouteCard | ({ type: "prioritas" } & KecamatanPriority);
export type AskResult = { answer: string; sources: Source[]; model: string | null; cards: Card[] };

/** Apa yang sudah dibaca dari hasil alat selama satu pertanyaan, untuk pemeriksaan jawaban. */
export type Seen = {
  /** Ada lokasi yang jawaban fasilitasnya sudah diperiksa tim dan statusnya bukan belum_diketahui. */
  checkedPlace: boolean;
};

/**
 * Satu jenis agen: daftar alat, instruksi sistem, dan pemeriksaan jawaban. Agen kontributor (ADR-0043) dan asisten rute
 * publik (ADR-0050) memakai putaran alat yang sama dengan profil berbeda.
 */
export type AgentProfile = {
  tools: readonly RegisteredTool[];
  /** `ctx` hanya untuk membaca apakah titik awal ada; nilai posisinya tidak boleh masuk instruksi. */
  system: (place?: ChosenPlace, ctx?: ToolContext) => string;
  guard: (text: string, seen: Seen) => string;
};

export const CONTRIBUTOR_PROFILE: AgentProfile = { tools: AGENT_TOOLS, system: systemPrompt, guard: guardRouteClaims };

type Checked = { checkedByTeam?: unknown; status?: unknown };
const isChecked = (p: Checked) => p.checkedByTeam === true && p.status !== "belum_diketahui";
/** Hasil alat yang memuat lokasi terperiksa tim: satu lokasi (place_accessibility) atau daftar (find_place, nearby_places). */
function hasCheckedPlace(result: unknown) {
  const value = (result ?? {}) as Checked & { places?: unknown };
  return isChecked(value) || (Array.isArray(value.places) && (value.places as Checked[]).some(isChecked));
}

type Deps = { model: AgentModel; ctx: ToolContext; deadlineMs?: number; profile?: AgentProfile };

/**
 * Jawaban agen untuk satu pertanyaan. `placeId` diisi bila pengguna bertanya dari halaman sebuah tempat; melempar 404
 * bila tempatnya tidak ada.
 */
export async function askAgent(
  { model, ctx, deadlineMs = QUESTION_DEADLINE_MS, profile = CONTRIBUTOR_PROFILE }: Deps,
  input: { placeId?: string; question: string; history?: Turn[] },
): Promise<AskResult> {
  const place = input.placeId ? ((await runTool(ctx, "place_accessibility", { placeId: input.placeId }, profile.tools)) as ChosenPlace) : undefined;
  const seen: Seen = { checkedPlace: place ? hasCheckedPlace(place) : false };
  const sources = new Map<string, Source>();
  const addPlace = (p: { id: string; name: string; lastVerifiedAt: string; verifiedBy: "tim" | "admin" }) =>
    sources.set(`lokasi:${p.id}`, { type: "lokasi", placeId: p.id, name: p.name, lastVerifiedAt: p.lastVerifiedAt, verifiedBy: p.verifiedBy });
  let searched = false;
  const addPassages = (passages: KnowledgeHit[]) => {
    searched = true;
    for (const p of passages) {
      sources.set(`pengetahuan:${p.citation}`, { type: "pengetahuan", citation: p.citation, title: p.source.title, url: p.source.url, license: p.source.license, attribution: p.source.attribution });
    }
  };
  if (place) addPlace(place);

  const cards: Card[] = [];
  /**
   * Menjalankan satu panggilan alat. Galat dan argumen yang salah dikembalikan ke model sebagai hasil alat dengan
   * `isError`. Alat kartu hanya mengembalikan `pesan` ke model; kartunya disimpan untuk web.
   */
  const run = async (call: ToolCall): Promise<{ content: string; isError?: true }> => {
    try {
      const result = await runTool(ctx, call.name, call.input, profile.tools);
      if (hasCheckedPlace(result)) seen.checkedPlace = true;
      if (call.name === "place_accessibility") addPlace(result as { id: string; name: string; lastVerifiedAt: string; verifiedBy: "tim" | "admin" });
      if (call.name === "search_knowledge") addPassages((result as { passages: KnowledgeHit[] }).passages);
      if (call.name === "kecamatan_priority") {
        const priority = result as KecamatanPriority;
        cards.push({ type: "prioritas", ...priority });
        sources.set("prioritas", {
          type: "pengetahuan",
          citation: `${priority.source.title}, ${priority.year}`,
          title: priority.source.title,
          url: priority.source.url,
          license: priority.source.terms,
          attribution: priority.source.publisher,
        });
      }
      if (CARD_TOOLS.has(call.name)) {
        const { pesan, kartu } = result as { pesan: string; kartu: PlaceCard | RouteCard };
        cards.push(kartu);
        return { content: JSON.stringify({ pesan }) };
      }
      return { content: JSON.stringify(result) };
    } catch (error) {
      if (error instanceof HttpError) return { content: JSON.stringify({ galat: error.code, pesan: error.message }), isError: true };
      throw error;
    }
  };

  const system = profile.system(place, ctx);
  const tools = toolDefinitions(profile.tools);
  const messages: AgentMessage[] = [...(input.history ?? []), { role: "user", content: input.question }];
  const signal = AbortSignal.timeout(deadlineMs);
  let answeredBy: string | null = null;
  let corrected = false;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const last = round === MAX_TOOL_ROUNDS;
    const turn = await model.next({ system, messages, tools, toolChoice: last ? "none" : "auto", signal });
    answeredBy = turn.model ?? answeredBy;
    // Model menolak, jawabannya terpotong, atau kosong: jawaban tetap, tanpa langkah tambahan.
    if (turn.kind === "no_answer") break;
    if (turn.kind === "answer" && !searched && !corrected && !last && CITES_REGULATION.test(turn.text)) {
      // Model menyebut peraturan dari ingatannya. Server menjalankan search_knowledge dengan pertanyaan pengguna, lalu
      // meminta jawaban ulang dari potongan yang ditemukan. Hanya sekali per pertanyaan.
      corrected = true;
      const call: ToolCall = { id: "cek-sumber", name: "search_knowledge", input: { query: input.question.slice(0, 300) } };
      messages.push({ role: "assistant", content: "", toolCalls: [call] }, { role: "tool", toolCallId: call.id, name: call.name, ...(await run(call)) });
      continue;
    }
    if (turn.kind === "answer") return { answer: profile.guard(turn.text, seen), sources: [...sources.values()], model: answeredBy, cards };
    if (last) break;
    if (turn.text && turn.calls.every((call) => CARD_TOOLS.has(call.name))) {
      // Model sudah menulis jawabannya dan hanya meminta kartu: kartu ditampilkan tanpa langkah model tambahan.
      for (const call of turn.calls.slice(0, MAX_CALLS_PER_ROUND)) await run(call);
      return { answer: profile.guard(turn.text, seen), sources: [...sources.values()], model: answeredBy, cards };
    }
    messages.push({ role: "assistant", content: turn.text ?? "", toolCalls: turn.calls, raw: turn.raw });
    for (const [index, call] of turn.calls.entries()) {
      const result =
        index < MAX_CALLS_PER_ROUND
          ? await run(call)
          : { content: JSON.stringify({ galat: "terlalu_banyak_panggilan", pesan: `Paling banyak ${MAX_CALLS_PER_ROUND} panggilan alat per putaran.` }), isError: true as const };
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, ...result });
    }
  }
  return { answer: NO_ANSWER, sources: [...sources.values()], model: answeredBy, cards };
}
