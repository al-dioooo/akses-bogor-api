import { describe, expect, it, vi } from "vitest";
import { AgentBusyError, type AgentStep } from "../src/agent/model.js";
import { DEFAULT_MODELS, OPENROUTER_URL, openRouterModel } from "../src/agent/openrouter.js";
import { toolDefinitions } from "../src/agent/registry.js";

const models = ["a/satu:free", "b/dua:free", "c/tiga:free", "d/empat:free", "e/lima:free"];
const step: AgentStep = { system: "Aturan", messages: [{ role: "user", content: "Ada ramp?" }], tools: toolDefinitions() };

const answer = (content: string, model = "a/satu:free") => Response.json({ model, choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] });
const failure = (status: number, metadata?: Record<string, unknown>) => Response.json({ error: { code: status, message: "galat", metadata } }, { status });
const bodyOf = (fetch: ReturnType<typeof vi.fn>, call = 0) => JSON.parse((fetch.mock.calls[call]![1] as RequestInit).body as string);

describe("openRouterModel", () => {
  it("sends the conversation, tools and privacy routing, and returns the answer with the model", async () => {
    const fetch = vi.fn(async () => answer("Ramp tersedia.", "b/dua:free"));
    const turn = await openRouterModel({ apiKey: "sk-or-tes", models, fetch }).next({
      ...step,
      messages: [
        { role: "user", content: "Ada ramp?" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "find_place", input: { query: "halte" } }] },
        { role: "tool", toolCallId: "c1", name: "find_place", content: '{"places":[]}' },
      ],
    });
    expect(turn).toEqual({ kind: "answer", text: "Ramp tersedia.", model: "b/dua:free" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(OPENROUTER_URL);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk-or-tes");
    expect(new Headers(init.headers).has("http-referer")).toBe(false);
    const body = bodyOf(fetch);
    expect(body).toMatchObject({
      models: ["a/satu:free", "b/dua:free", "c/tiga:free"],
      tool_choice: "auto",
      provider: { data_collection: "deny", require_parameters: true },
      reasoning: { exclude: true },
    });
    expect(body.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(["find_place", "place_accessibility", "search_knowledge"]);
    expect(body.messages).toEqual([
      { role: "system", content: "Aturan" },
      { role: "user", content: "Ada ramp?" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "find_place", arguments: '{"query":"halte"}' } }] },
      { role: "tool", tool_call_id: "c1", content: '{"places":[]}' },
    ]);
  });

  it("returns tool calls with parsed arguments, and passes broken JSON through for the schema to reject", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        model: "a/satu:free",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
                { id: "x1", type: "function", function: { name: "search_knowledge", arguments: '{"query":"ramp"}' } },
                { id: "x2", type: "function", function: { name: "find_place", arguments: "{query: halte" } },
              ],
            },
          },
        ],
      }),
    );
    const turn = await openRouterModel({ apiKey: "sk-or-tes", models, fetch }).next({ ...step, toolChoice: "none" });
    expect(turn).toEqual({
      kind: "tool_calls",
      text: undefined,
      model: "a/satu:free",
      calls: [
        { id: "x1", name: "search_knowledge", input: { query: "ramp" } },
        { id: "x2", name: "find_place", input: "{query: halte" },
      ],
    });
    expect(bodyOf(fetch).tool_choice).toBe("none");
  });

  it("moves to the next group of models when a whole group fails", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(failure(429, { provider_name: "Google AI Studio", raw: "rate-limited upstream" }))
      .mockResolvedValueOnce(answer("Jawaban cadangan.", "d/empat:free"));
    const log = { warn: vi.fn() };
    const turn = await openRouterModel({ apiKey: "sk-or-tes", models, fetch, log }).next(step);
    expect(turn).toMatchObject({ kind: "answer", text: "Jawaban cadangan.", model: "d/empat:free" });
    expect(bodyOf(fetch, 0).models).toEqual(["a/satu:free", "b/dua:free", "c/tiga:free"]);
    expect(bodyOf(fetch, 1).models).toEqual(["d/empat:free", "e/lima:free"]);
    // Log hanya berisi status, kode, dan model; tidak pernah isi percakapan.
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("Ada ramp?");
  });

  it("treats 404, 5xx, network errors, errors inside a 200 and empty answers as reasons to try the next group", async () => {
    for (const first of [
      () => failure(404),
      () => failure(503),
      () => Promise.reject(new TypeError("fetch failed")),
      () => Response.json({ error: { code: 502, message: "provider" } }),
      () => Response.json({ choices: [{ finish_reason: "error", message: { content: "" } }] }),
      () => Response.json({ choices: [{ finish_reason: "length", message: { content: null } }] }),
    ]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce(async () => first()).mockResolvedValueOnce(answer("Oke."));
      await expect(openRouterModel({ apiKey: "sk-or-tes", models, fetch }).next(step)).resolves.toMatchObject({ text: "Oke." });
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  });

  it("stops with a busy error on the account limit, missing credit or a bad key, without trying more models", async () => {
    for (const [status, reason] of [
      [429, "kuota"],
      [402, "kredit"],
      [401, "belum_diatur"],
    ] as const) {
      const fetch = vi.fn(async () => failure(status));
      const error = await openRouterModel({ apiKey: "sk-or-tes", models, fetch })
        .next(step)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AgentBusyError);
      expect((error as AgentBusyError).reason).toBe(reason);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("is busy when every group fails or the daily budget is used up", async () => {
    const failing = vi.fn(async () => failure(503));
    await expect(openRouterModel({ apiKey: "sk-or-tes", models, fetch: failing }).next(step)).rejects.toMatchObject({ reason: "semua_gagal" });
    expect(failing).toHaveBeenCalledTimes(2);

    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(failure(503)).mockResolvedValueOnce(answer("Oke."));
    let left = 1;
    const take = () => left-- > 0;
    await expect(openRouterModel({ apiKey: "sk-or-tes", models, fetch, take }).next(step)).rejects.toMatchObject({ reason: "kuota" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stops when the question's deadline has passed", async () => {
    const fetch = vi.fn(async () => answer("Oke."));
    const controller = new AbortController();
    controller.abort();
    await expect(openRouterModel({ apiKey: "sk-or-tes", models, fetch }).next({ ...step, signal: controller.signal })).rejects.toMatchObject({ reason: "tenggat" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses only free models by default", () => {
    expect(DEFAULT_MODELS.length).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_MODELS.every((m) => m.endsWith(":free"))).toBe(true);
  });
});
