// Adapter OpenRouter untuk agen rute (ADR-0042, ADR-0043): chat completions format OpenAI dengan tool calling, lewat
// `fetch` biasa. Isi permintaan dan jawaban tidak pernah dicatat di log; yang dicatat hanya status, kode, dan model.
import { AgentBusyError, type AgentMessage, type AgentModel, type AgentStep, type AgentTurn, type ToolCall } from "./model.js";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Model gratis dengan tool calling yang lolos `data_collection: "deny"`, berurutan, dipilih 2026-11-22 (ADR-0043).
 * Bisa diganti lewat `OPENROUTER_MODELS`.
 */
export const DEFAULT_MODELS = ["google/gemma-4-31b-it:free", "baidu/ernie-5.5-flash-preview:free", "inclusionai/ling-3.2-flash:free", "google/gemma-4-26b-a4b-it:free"];
/** Model per permintaan di parameter `models`; OpenRouter mencoba yang berikutnya di dalam permintaan yang sama. */
export const MODELS_PER_REQUEST = 3;
const TIMEOUT_MS = 30_000;
const MAX_TOKENS = 1200;

export type OpenRouterLog = { warn: (details: Record<string, unknown>, message: string) => void };

type Options = {
  apiKey: string;
  models?: readonly string[];
  fetch?: typeof fetch;
  /** Dipanggil sebelum setiap permintaan HTTP; `false` berarti batas harian untuk semua pengguna sudah habis. */
  take?: () => boolean;
  log?: OpenRouterLog;
};

type WireToolCall = { id?: string; type?: string; function?: { name?: string; arguments?: string } };
type WireAnswer = {
  model?: string;
  error?: { code?: number | string; message?: string; metadata?: Record<string, unknown> };
  choices?: { finish_reason?: string | null; error?: unknown; message?: { content?: string | null; tool_calls?: WireToolCall[] } }[];
};

/** Galat dari satu permintaan yang boleh dicoba lagi dengan kelompok model berikutnya. */
class RetryableError extends Error {}

function wireMessages(system: string, messages: AgentMessage[]) {
  return [
    { role: "system", content: system },
    ...messages.map((m) => {
      if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
      if (m.role === "assistant" && m.toolCalls?.length) {
        return {
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })),
        };
      }
      return { role: m.role, content: m.content };
    }),
  ];
}

/** Argumen alat dari model berupa string JSON. String yang rusak diteruskan apa adanya supaya ditolak skema alat. */
function parseArguments(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Galat OpenRouter menjadi keputusan: berhenti dengan jawaban sibuk, atau coba kelompok model berikutnya. */
function classify(status: number, body: WireAnswer | null): AgentBusyError | RetryableError | Error {
  const code = Number(body?.error?.code ?? status);
  const metadata = body?.error?.metadata ?? {};
  if (code === 402) return new AgentBusyError("kredit");
  // 429 dari penyedia di belakang OpenRouter membawa nama penyedianya; 429 tanpa itu berarti batas akun OpenRouter.
  if (code === 429) return "provider_name" in metadata || "raw" in metadata ? new RetryableError("429 dari penyedia") : new AgentBusyError("kuota");
  if (code === 401) return new AgentBusyError("belum_diatur");
  if (code === 404 || code === 408 || code >= 500) return new RetryableError(`OpenRouter menjawab ${code}`);
  return new Error(`OpenRouter menjawab ${code}`);
}

function turnOf(body: WireAnswer | null): AgentTurn {
  const choice = body?.choices?.[0];
  if (!choice || choice.error || choice.finish_reason === "error") throw new RetryableError("jawaban model berisi galat");
  const message = choice.message ?? {};
  const text = typeof message.content === "string" ? message.content.trim() : "";
  const calls: ToolCall[] = (message.tool_calls ?? [])
    .filter((c) => c.function?.name)
    .map((c, i) => ({ id: c.id || `panggilan-${i + 1}`, name: c.function!.name!, input: parseArguments(c.function!.arguments) }));
  if (calls.length > 0) return { kind: "tool_calls", calls, text: text || undefined, model: body?.model };
  if (!text) throw new RetryableError("jawaban model kosong");
  return { kind: "answer", text, model: body?.model };
}

/** `AgentModel` lewat OpenRouter dengan daftar model berurutan; lihat ADR-0043 untuk cadangan dan batasnya. */
export function openRouterModel({ apiKey, models = DEFAULT_MODELS, fetch = globalThis.fetch, take = () => true, log }: Options): AgentModel {
  const groups: string[][] = [];
  for (let i = 0; i < models.length; i += MODELS_PER_REQUEST) groups.push(models.slice(i, i + MODELS_PER_REQUEST));

  return {
    async next(step: AgentStep): Promise<AgentTurn> {
      for (const group of groups) {
        if (step.signal?.aborted) throw new AgentBusyError("tenggat");
        if (!take()) throw new AgentBusyError("kuota");
        const payload = {
          models: group,
          messages: wireMessages(step.system, step.messages),
          tools: step.tools,
          tool_choice: step.toolChoice ?? "auto",
          max_tokens: MAX_TOKENS,
          temperature: 0.2,
          reasoning: { effort: "low", exclude: true },
          provider: { data_collection: "deny", require_parameters: true },
        };
        let response: Response;
        let body: WireAnswer | null;
        try {
          const signals = [AbortSignal.timeout(TIMEOUT_MS), ...(step.signal ? [step.signal] : [])];
          response = await fetch(OPENROUTER_URL, {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.any(signals),
          });
          body = (await response.json().catch(() => null)) as WireAnswer | null;
        } catch {
          if (step.signal?.aborted) throw new AgentBusyError("tenggat");
          log?.warn({ models: group }, "OpenRouter tidak bisa dihubungi atau terlalu lama");
          continue;
        }
        try {
          // Galat bisa datang dengan status 200, jadi badan jawaban selalu diperiksa.
          if (!response.ok || body?.error) throw classify(response.status, body);
          return turnOf(body);
        } catch (error) {
          if (!(error instanceof RetryableError)) {
            log?.warn({ models: group, status: response.status, code: body?.error?.code }, "OpenRouter menolak permintaan");
            throw error;
          }
          log?.warn({ models: group, status: response.status, code: body?.error?.code }, `kelompok model gagal: ${error.message}`);
        }
      }
      throw new AgentBusyError("semua_gagal");
    },
  };
}
