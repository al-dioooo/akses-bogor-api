import { describe, expect, it, vi } from "vitest";
import { DEFAULT_EFFORT, DEFAULT_MODEL, MAX_TOKENS, anthropicModel } from "../src/agent/anthropic.js";
import { AgentBusyError, type AgentStep } from "../src/agent/model.js";
import { toolDefinitions } from "../src/agent/registry.js";

const step: AgentStep = { system: "Aturan", messages: [{ role: "user", content: "Ada ramp?" }], tools: toolDefinitions() };
const usage = { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 4000, cache_creation_input_tokens: 56 };

/** Jawaban Claude API tiruan dengan blok konten dan alasan berhenti tertentu. */
const message = (content: unknown[], stop_reason = "end_turn") =>
  Response.json({ id: "msg_1", type: "message", role: "assistant", model: DEFAULT_MODEL, content, stop_reason, stop_details: null, stop_sequence: null, usage });
const failure = (status: number, type: string, details?: Record<string, unknown>) =>
  Response.json({ type: "error", error: { type, message: "galat", ...(details ? { details } : {}) }, request_id: "req_1" }, { status, headers: { "retry-after-ms": "0", "request-id": "req_1" } });
const bodyOf = (fetch: ReturnType<typeof vi.fn>, call = 0) => JSON.parse((fetch.mock.calls[call]![1] as RequestInit).body as string);
const model = (fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof anthropicModel>[0]> = {}) =>
  anthropicModel({ apiKey: "sk-ant-tes", fetch, maxRetries: 0, ...extra });

describe("anthropicModel", () => {
  it("asks Claude Haiku 5.5 with effort, caching and no sampling parameters, and logs only token counts", async () => {
    const fetch = vi.fn(async () => message([{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: " Ramp tersedia. " }]));
    const log = { info: vi.fn(), warn: vi.fn() };
    const turn = await model(fetch, { log }).next(step);
    expect(turn).toEqual({ kind: "answer", text: "Ramp tersedia.", model: DEFAULT_MODEL });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk-ant-tes");
    const body = bodyOf(fetch);
    expect(body).toMatchObject({
      model: "claude-haiku-5-5",
      max_tokens: MAX_TOKENS,
      output_config: { effort: DEFAULT_EFFORT },
      system: [{ type: "text", text: "Aturan", cache_control: { type: "ephemeral" } }],
      tool_choice: { type: "auto" },
      cache_control: { type: "ephemeral" },
      messages: [{ role: "user", content: "Ada ramp?" }],
    });
    for (const key of ["temperature", "top_p", "top_k", "thinking", "fallbacks"]) expect(body).not.toHaveProperty(key);
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(toolDefinitions().map((t) => t.function.name));
    expect(body.tools[0]).toEqual({ name: "find_place", description: toolDefinitions()[0]!.function.description, input_schema: toolDefinitions()[0]!.function.parameters });
    expect(body.tools.at(-1).cache_control).toEqual({ type: "ephemeral" });
    expect(log.info).toHaveBeenCalledWith({ model: DEFAULT_MODEL, stop: "end_turn", input: 12, output: 34, cacheRead: 4000, cacheWrite: 56 }, "langkah agen Claude");
    expect(JSON.stringify(log.info.mock.calls)).not.toMatch(/ramp|sk-ant/i);
  });

  it("replays the provider's blocks unchanged and sends all tool results of a round in one user message", async () => {
    const raw = [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: "Saya cari dulu.", citations: null },
      { type: "tool_use", id: "c1", name: "find_place", input: { query: "halte" } },
      { type: "tool_use", id: "c2", name: "place_accessibility", input: { placeId: "bukan-uuid" } },
    ];
    const fetch = vi.fn(async () => message([{ type: "text", text: "Belum tercatat." }]));
    await model(fetch, { effort: "medium" }).next({
      ...step,
      messages: [
        { role: "assistant", content: "Halo, ada yang bisa dibantu?" },
        { role: "user", content: "Ada ramp?" },
        { role: "assistant", content: "Saya cari dulu.", toolCalls: [], raw },
        { role: "tool", toolCallId: "c1", name: "find_place", content: '{"places":[]}' },
        { role: "tool", toolCallId: "c2", name: "place_accessibility", content: '{"galat":"input_tidak_valid"}', isError: true },
        { role: "assistant", content: "", toolCalls: [{ id: "cek-sumber", name: "search_knowledge", input: { query: "ramp" } }] },
        { role: "tool", toolCallId: "cek-sumber", name: "search_knowledge", content: '{"passages":[]}' },
      ],
    });
    const body = bodyOf(fetch);
    expect(body.output_config).toEqual({ effort: "medium" });
    expect(body.messages).toEqual([
      { role: "user", content: "Ada ramp?" },
      { role: "assistant", content: raw },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "c1", content: '{"places":[]}' },
          { type: "tool_result", tool_use_id: "c2", content: '{"galat":"input_tidak_valid"}', is_error: true },
        ],
      },
      { role: "assistant", content: [{ type: "tool_use", id: "cek-sumber", name: "search_knowledge", input: { query: "ramp" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "cek-sumber", content: '{"passages":[]}' }] },
    ]);
  });

  it("returns tool calls with the whole turn, reading blocks by type, and asks for no tools on the last round", async () => {
    const content = [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: "Saya cari dulu." },
      { type: "tool_use", id: "toolu_1", name: "search_knowledge", input: { query: "ramp" } },
    ];
    const fetch = vi.fn(async () => message(content, "tool_use"));
    const turn = await model(fetch).next({ ...step, toolChoice: "none" });
    expect(turn).toEqual({ kind: "tool_calls", calls: [{ id: "toolu_1", name: "search_knowledge", input: { query: "ramp" } }], text: "Saya cari dulu.", model: DEFAULT_MODEL, raw: content });
    expect(bodyOf(fetch).tool_choice).toEqual({ type: "none" });
  });

  it("gives no answer when Claude refuses, is cut off, or writes no text", async () => {
    const cases = [
      [message([], "refusal"), "ditolak"],
      [message([{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "Ramp ters" }], "max_tokens"), "terpotong"],
      [message([{ type: "thinking", thinking: "", signature: "sig" }]), "kosong"],
    ] as const;
    for (const [reply, reason] of cases) {
      const turn = await model(async () => reply).next(step);
      expect(turn).toEqual({ kind: "no_answer", reason, model: DEFAULT_MODEL });
    }
  });

  it("turns API errors into busy reasons and gives the daily request back", async () => {
    const cases = [
      [failure(401, "authentication_error"), "belum_diatur"],
      [failure(403, "permission_error"), "belum_diatur"],
      [failure(404, "not_found_error"), "belum_diatur"],
      [failure(402, "billing_error"), "kredit"],
      [failure(429, "rate_limit_error", { error_code: "enforced_spend_limit_reached" }), "kredit"],
      [failure(429, "rate_limit_error"), "kuota"],
      [failure(529, "overloaded_error"), "semua_gagal"],
      [failure(500, "api_error"), "semua_gagal"],
      [failure(400, "invalid_request_error"), "semua_gagal"],
    ] as const;
    const budget = { take: vi.fn(() => true), give: vi.fn() };
    const log = { info: vi.fn(), warn: vi.fn() };
    for (const [reply, reason] of cases) {
      await expect(model(async () => reply, { budget, log }).next(step)).rejects.toEqual(new AgentBusyError(reason));
    }
    const offline = vi.fn(async () => Promise.reject(new TypeError("fetch failed")));
    await expect(model(offline, { budget }).next(step)).rejects.toEqual(new AgentBusyError("semua_gagal"));
    expect(budget.give).toHaveBeenCalledTimes(cases.length + 1);
    expect(log.warn).toHaveBeenCalledWith({ status: 429, type: "rate_limit_error", code: null, requestId: "req_1" }, "Claude API menolak atau gagal dihubungi");
    expect(log.info).not.toHaveBeenCalled();
  });

  it("retries an overloaded API once before answering busy", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(failure(529, "overloaded_error")).mockResolvedValueOnce(message([{ type: "text", text: "Ada." }]));
    expect(await anthropicModel({ apiKey: "sk-ant-tes", fetch }).next(step)).toMatchObject({ kind: "answer", text: "Ada." });
    const twice = vi.fn(async () => failure(529, "overloaded_error"));
    await expect(anthropicModel({ apiKey: "sk-ant-tes", fetch: twice }).next(step)).rejects.toEqual(new AgentBusyError("semua_gagal"));
    expect(twice).toHaveBeenCalledTimes(2);
  });

  it("is busy without a key, an exhausted daily budget, or after the question deadline, without calling the API", async () => {
    const fetch = vi.fn(async () => message([{ type: "text", text: "Ada." }]));
    await expect(anthropicModel({ fetch }).next(step)).rejects.toEqual(new AgentBusyError("belum_diatur"));
    await expect(model(fetch, { budget: { take: () => false, give: vi.fn() } }).next(step)).rejects.toEqual(new AgentBusyError("kuota"));
    await expect(model(fetch).next({ ...step, signal: AbortSignal.abort() })).rejects.toEqual(new AgentBusyError("tenggat"));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops waiting when the question deadline passes mid-request", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
          controller.abort();
        }),
    );
    await expect(model(fetch).next({ ...step, signal: controller.signal })).rejects.toEqual(new AgentBusyError("tenggat"));
  });
});
