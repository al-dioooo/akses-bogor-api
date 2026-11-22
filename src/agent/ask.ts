// Satu pertanyaan ke agen rute (ADR-0043): putaran alat yang dibatasi, argumen alat diperiksa skema Zod, dan sumber
// dikumpulkan dari hasil alat. Tidak ada yang disimpan; percakapan hanya hidup selama permintaan ini.
import { HttpError } from "../http/errors.js";
import type { KnowledgeHit } from "../knowledge/search.js";
import type { AgentMessage, AgentModel, ToolCall } from "./model.js";
import { guardRouteClaims, systemPrompt } from "./prompt.js";
import { runTool, toolDefinitions } from "./registry.js";
import { placeAccessibility, type ToolContext } from "./tools.js";

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
  | { type: "lokasi"; placeId: string; name: string; lastVerifiedAt: string }
  | { type: "pengetahuan"; citation: string; title: string; url: string; license: string; attribution: string | null };
export type AskResult = { answer: string; sources: Source[]; model: string | null };

type Deps = { model: AgentModel; ctx: ToolContext; deadlineMs?: number };

/** Jawaban agen untuk satu pertanyaan tentang tempat yang dipilih. Melempar 404 bila tempatnya tidak ada. */
export async function askAgent({ model, ctx, deadlineMs = QUESTION_DEADLINE_MS }: Deps, input: { placeId: string; question: string; history?: Turn[] }): Promise<AskResult> {
  const place = await placeAccessibility(ctx, { placeId: input.placeId });
  const sources = new Map<string, Source>();
  const addPlace = (p: { id: string; name: string; lastVerifiedAt: string }) =>
    sources.set(`lokasi:${p.id}`, { type: "lokasi", placeId: p.id, name: p.name, lastVerifiedAt: p.lastVerifiedAt });
  let searched = false;
  const addPassages = (passages: KnowledgeHit[]) => {
    searched = true;
    for (const p of passages) {
      sources.set(`pengetahuan:${p.citation}`, { type: "pengetahuan", citation: p.citation, title: p.source.title, url: p.source.url, license: p.source.license, attribution: p.source.attribution });
    }
  };
  addPlace(place);

  /** Menjalankan satu panggilan alat. Galat dan argumen yang salah dikembalikan ke model sebagai hasil alat. */
  const run = async (call: ToolCall): Promise<string> => {
    try {
      const result = await runTool(ctx, call.name, call.input);
      if (call.name === "place_accessibility") addPlace(result as typeof place);
      if (call.name === "search_knowledge") addPassages((result as { passages: KnowledgeHit[] }).passages);
      return JSON.stringify(result);
    } catch (error) {
      if (error instanceof HttpError) return JSON.stringify({ galat: error.code, pesan: error.message });
      throw error;
    }
  };

  const system = systemPrompt(place);
  const tools = toolDefinitions();
  const messages: AgentMessage[] = [...(input.history ?? []), { role: "user", content: input.question }];
  const signal = AbortSignal.timeout(deadlineMs);
  let answeredBy: string | null = null;
  let corrected = false;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const last = round === MAX_TOOL_ROUNDS;
    const turn = await model.next({ system, messages, tools, toolChoice: last ? "none" : "auto", signal });
    answeredBy = turn.model ?? answeredBy;
    if (turn.kind === "answer" && !searched && !corrected && !last && CITES_REGULATION.test(turn.text)) {
      // Model menyebut peraturan dari ingatannya. Server menjalankan search_knowledge dengan pertanyaan pengguna, lalu
      // meminta jawaban ulang dari potongan yang ditemukan. Hanya sekali per pertanyaan.
      corrected = true;
      const call: ToolCall = { id: "cek-sumber", name: "search_knowledge", input: { query: input.question.slice(0, 300) } };
      messages.push({ role: "assistant", content: "", toolCalls: [call] }, { role: "tool", toolCallId: call.id, name: call.name, content: await run(call) });
      continue;
    }
    if (turn.kind === "answer") return { answer: guardRouteClaims(turn.text), sources: [...sources.values()], model: answeredBy };
    if (last) break;
    messages.push({ role: "assistant", content: turn.text ?? "", toolCalls: turn.calls });
    for (const [index, call] of turn.calls.entries()) {
      const content =
        index < MAX_CALLS_PER_ROUND
          ? await run(call)
          : JSON.stringify({ galat: "terlalu_banyak_panggilan", pesan: `Paling banyak ${MAX_CALLS_PER_ROUND} panggilan alat per putaran.` });
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content });
    }
  }
  return { answer: NO_ANSWER, sources: [...sources.values()], model: answeredBy };
}
