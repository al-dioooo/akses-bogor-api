// Antarmuka kecil untuk model bahasa agen rute (ADR-0042). Fase 1 sengaja tanpa implementasi karena penyedia model
// belum dipilih. Implementasi nanti (mis. model lewat OpenRouter, atau Claude) cukup memenuhi tipe ini: alat, route,
// dan basis pengetahuan tidak berubah.
import type { ToolDefinition } from "./registry.js";

export type ToolCall = { id: string; name: string; input: unknown };

export type AgentMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

/** Hasil satu langkah model: jawaban akhir, atau permintaan memanggil alat lalu melanjutkan. */
export type AgentTurn = { kind: "answer"; text: string } | { kind: "tool_calls"; calls: ToolCall[]; text?: string };

export interface AgentModel {
  /** Satu langkah: instruksi sistem, percakapan sejauh ini, dan alat yang boleh dipanggil. */
  next(input: { system: string; messages: AgentMessage[]; tools: ToolDefinition[] }): Promise<AgentTurn>;
}
