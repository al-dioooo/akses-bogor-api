// Antarmuka kecil untuk model bahasa agen rute (ADR-0042). Penyedianya model gratis lewat OpenRouter; adapternya cukup
// memenuhi tipe ini, jadi alat, route, dan basis pengetahuan tidak berubah bila model atau penyedianya diganti.
// Model hanya menerima pertanyaan, giliran sebelumnya, tempat yang dipilih, dan hasil alat di `registry.ts`; tidak
// pernah koordinat pengguna atau rute.
import type { ToolDefinition } from "./registry.js";

export type ToolCall = { id: string; name: string; input: unknown };

export type AgentMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

/** Hasil satu langkah model: jawaban akhir, atau permintaan memanggil alat lalu melanjutkan. `model` adalah yang menjawab. */
export type AgentTurn = { kind: "answer"; text: string; model?: string } | { kind: "tool_calls"; calls: ToolCall[]; text?: string; model?: string };

export type AgentStep = {
  /** Instruksi sistem. */
  system: string;
  /** Percakapan sejauh ini. */
  messages: AgentMessage[];
  /** Alat yang boleh dipanggil, dalam format `tools` OpenAI. */
  tools: ToolDefinition[];
  /** `none` meminta model menjawab tanpa memanggil alat, mis. di putaran terakhir. Bawaan `auto`. */
  toolChoice?: "auto" | "none";
  /** Dibatalkan bila tenggat satu pertanyaan habis. */
  signal?: AbortSignal;
};

export interface AgentModel {
  /** Satu langkah model. Melempar `AgentBusyError` bila model tidak bisa dipakai sekarang. */
  next(step: AgentStep): Promise<AgentTurn>;
}

/** Model tidak bisa dipakai sekarang: kuota habis, saldo kurang, API key belum diisi, atau semua model gagal. */
export class AgentBusyError extends Error {
  constructor(readonly reason: "kuota" | "kredit" | "belum_diatur" | "semua_gagal" | "tenggat") {
    super(`Model agen sibuk: ${reason}`);
    this.name = "AgentBusyError";
  }
}
