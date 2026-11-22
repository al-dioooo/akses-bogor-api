// Adapter Claude API untuk agen kontributor (ADR-0047), lewat SDK resmi `@anthropic-ai/sdk`. Putaran alat tetap di
// `ask.ts` dan alat tetap dijalankan di API ini, jadi model tidak pernah menerima posisi pengguna, rute, atau keluaran
// Mapbox. Log hanya berisi model, alasan berhenti, jumlah token, dan galat; tidak pernah isi percakapan atau API key.
import Anthropic from "@anthropic-ai/sdk";
import { AgentBusyError, type AgentMessage, type AgentModel, type AgentStep, type AgentTurn, type ToolCall } from "./model.js";
import type { RequestBudget } from "./openrouter.js";
import type { ToolDefinition } from "./registry.js";

export const DEFAULT_MODEL = "claude-haiku-5-5";
export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];
/** Dipilih dari `pnpm agen:evaluasi` (ADR-0047). Bisa diganti lewat `ANTHROPIC_EFFORT`. */
export const DEFAULT_EFFORT: Effort = "low";
/** Thinking ikut dihitung di `max_tokens`, jadi batasnya jauh di atas panjang jawaban (sekitar 120 kata). */
export const MAX_TOKENS = 4096;
/** Satu kali ulang dari SDK untuk 429, 5xx, dan galat koneksi; tenggat 60 detik per pertanyaan tetap berlaku. */
export const MAX_RETRIES = 1;
const TIMEOUT_MS = 30_000;
const CACHE: Anthropic.CacheControlEphemeral = { type: "ephemeral" };
/** Batas pengeluaran organisasi atau workspace yang tercapai; diperlakukan seperti saldo habis. */
const SPEND_LIMIT_CODES = new Set(["enforced_spend_limit_reached", "contract_spend_limit_reached", "linked_organization_spend_limit_reached"]);

export type AnthropicLog = {
  info: (details: Record<string, unknown>, message: string) => void;
  warn: (details: Record<string, unknown>, message: string) => void;
};

type Options = {
  /** Kosong berarti setiap langkah menjawab sibuk `belum_diatur`; SDK tidak dibuat dan tidak mencari kredensial lain. */
  apiKey?: string;
  model?: string;
  effort?: Effort;
  budget?: RequestBudget;
  log?: AnthropicLog;
  /** Untuk tes dan `deps.fetch` di app; bawaan `fetch` global. */
  fetch?: typeof fetch;
  /** Untuk tes; bawaan `MAX_RETRIES`. */
  maxRetries?: number;
};

/** Alat dalam format Claude API. Penanda cache di alat terakhir menyimpan semua alat, yang sama untuk setiap pertanyaan. */
function wireTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t, i) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
    ...(i === tools.length - 1 ? { cache_control: CACHE } : {}),
  }));
}

const toolUse = (call: ToolCall): Anthropic.ToolUseBlockParam => ({
  type: "tool_use",
  id: call.id,
  name: call.name,
  input: typeof call.input === "object" && call.input !== null ? (call.input as Record<string, unknown>) : {},
});

/**
 * Percakapan dalam format Claude API. Giliran dengan `raw` dikirim kembali apa adanya, termasuk blok thinking-nya.
 * Hasil alat yang berurutan digabung dalam satu pesan user. Giliran asisten di awal riwayat dibuang karena pesan pertama
 * harus dari user; hasilnya sama di setiap langkah, jadi riwayat yang dikirim tetap hanya bertambah di belakang.
 */
export function wireMessages(messages: AgentMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      const result: Anthropic.ToolResultBlockParam = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content, ...(m.isError ? { is_error: true } : {}) };
      const last = out.at(-1);
      if (last?.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) last.content.push(result);
      else out.push({ role: "user", content: [result] });
    } else if (m.role === "assistant") {
      if (Array.isArray(m.raw)) {
        out.push({ role: "assistant", content: m.raw as Anthropic.ContentBlockParam[] });
      } else if (m.toolCalls?.length) {
        const text: Anthropic.TextBlockParam[] = m.content.trim() ? [{ type: "text", text: m.content }] : [];
        out.push({ role: "assistant", content: [...text, ...m.toolCalls.map(toolUse)] });
      } else if (m.content.trim()) {
        out.push({ role: "assistant", content: m.content });
      }
    } else {
      out.push({ role: "user", content: m.content });
    }
  }
  while (out[0]?.role === "assistant") out.shift();
  return out;
}

/** Jawaban Claude menjadi langkah agen. Blok dibaca menurut `type`, karena jawaban bisa diawali blok thinking. */
export function turnOf(message: Anthropic.Message): AgentTurn {
  const model = message.model;
  if (message.stop_reason === "refusal") return { kind: "no_answer", reason: "ditolak", model };
  if (message.stop_reason === "max_tokens" || message.stop_reason === "model_context_window_exceeded") return { kind: "no_answer", reason: "terpotong", model };
  const text = message.content
    .flatMap((b) => (b.type === "text" ? [b.text.trim()] : []))
    .filter(Boolean)
    .join("\n\n");
  const calls: ToolCall[] = message.content.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, name: b.name, input: b.input }] : []));
  if (calls.length > 0) return { kind: "tool_calls", calls, text: text || undefined, model, raw: message.content };
  if (!text) return { kind: "no_answer", reason: "kosong", model };
  return { kind: "answer", text, model };
}

/** Galat SDK menjadi alasan sibuk. Galat yang bukan dari SDK (bug di kode ini) diteruskan apa adanya. */
function busyReason(error: unknown, signal: AbortSignal | undefined, log?: AnthropicLog): unknown {
  if (signal?.aborted || error instanceof Anthropic.APIUserAbortError) return new AgentBusyError("tenggat");
  if (!(error instanceof Anthropic.APIError)) return error;
  const details = { status: error.status ?? null, type: error.type, code: error.errorCode, requestId: error.requestID ?? null };
  log?.warn(details, "Claude API menolak atau gagal dihubungi");
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError || error instanceof Anthropic.NotFoundError) return new AgentBusyError("belum_diatur");
  if (error instanceof Anthropic.PaymentRequiredError || error.type === "billing_error" || SPEND_LIMIT_CODES.has(error.errorCode ?? "")) return new AgentBusyError("kredit");
  if (error instanceof Anthropic.RateLimitError) return new AgentBusyError("kuota");
  // 5xx termasuk 529 overloaded, koneksi gagal, dan batas waktu; juga 400 yang tidak terduga, yang tercatat di log di atas.
  return new AgentBusyError("semua_gagal");
}

/** `AgentModel` lewat Claude API; lihat ADR-0047 untuk model, effort, dan data yang dikirim. */
export function anthropicModel({ apiKey, model = DEFAULT_MODEL, effort = DEFAULT_EFFORT, budget, log, fetch, maxRetries = MAX_RETRIES }: Options): AgentModel {
  if (!apiKey) {
    return {
      next: async () => {
        throw new AgentBusyError("belum_diatur");
      },
    };
  }
  const client = new Anthropic({ apiKey, maxRetries, timeout: TIMEOUT_MS, ...(fetch ? { fetch } : {}) });

  return {
    async next(step: AgentStep): Promise<AgentTurn> {
      if (step.signal?.aborted) throw new AgentBusyError("tenggat");
      if (budget && !budget.take()) throw new AgentBusyError("kuota");
      let message: Anthropic.Message;
      try {
        message = await client.messages.create(
          {
            model,
            max_tokens: MAX_TOKENS,
            // Tanpa temperature, top_p, top_k, dan prefill: Haiku 5.5 menolaknya. Thinking adaptif menyala sebagai bawaan.
            output_config: { effort },
            // Penanda cache: alat (di wireTools), instruksi sistem, lalu otomatis di ujung percakapan untuk langkah berikutnya.
            system: [{ type: "text", text: step.system, cache_control: CACHE }],
            tools: wireTools(step.tools),
            tool_choice: step.toolChoice === "none" ? { type: "none" } : { type: "auto" },
            cache_control: CACHE,
            messages: wireMessages(step.messages),
          },
          { signal: step.signal },
        );
      } catch (error) {
        // Permintaan yang gagal tidak memakai jatah harian.
        budget?.give();
        throw busyReason(error, step.signal, log);
      }
      const usage = message.usage;
      log?.info(
        {
          model: message.model,
          stop: message.stop_reason,
          input: usage.input_tokens,
          output: usage.output_tokens,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          cacheWrite: usage.cache_creation_input_tokens ?? 0,
        },
        "langkah agen Claude",
      );
      return turnOf(message);
    },
  };
}
