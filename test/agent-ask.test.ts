import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_CALLS_PER_ROUND, MAX_TOOL_ROUNDS, NO_ANSWER, askAgent } from "../src/agent/ask.js";
import { AgentBusyError, type AgentModel, type AgentStep, type AgentTurn } from "../src/agent/model.js";
import { ROUTE_CLAIM_NOTE } from "../src/agent/prompt.js";
import type { Db } from "../src/db/client.js";
import { seedSampleData } from "../src/db/seed.js";
import { insertPassages, replaceSource } from "../src/knowledge/store.js";
import { placesNamed } from "../src/places/queries.js";
import { createTestDb } from "./helpers/db.js";

let db: Db;
let close: () => Promise<void>;
let halteId: string;
const now = () => new Date("2026-11-22T05:00:00.000Z");
const ctx = () => ({ db, now });

/** Model tiruan yang menjawab langkah demi langkah dan menyalin setiap langkah yang diterimanya. */
function scripted(...turns: AgentTurn[]) {
  const steps: AgentStep[] = [];
  const model: AgentModel = {
    next: vi.fn(async (step: AgentStep) => {
      steps.push(structuredClone({ ...step, signal: undefined }));
      const turn = turns.shift();
      if (!turn) throw new Error("langkah tidak terduga");
      return turn;
    }),
  };
  return { model, steps };
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedSampleData(db);
  const source = { id: "permen-pupr-14-2017", kind: "regulasi" as const, title: "Permen PUPR No. 14/PRT/M/2017", url: "https://jdih.pu.go.id/", license: "Tanpa hak cipta", retrievedAt: now() };
  await replaceSource(db, source, (tx) => insertPassages(tx, source.id, [{ citation: "Permen PUPR No. 14/PRT/M/2017, Lampiran II, B.2 Ram", body: "Kemiringan ram di dalam bangunan paling besar 1:12." }]));
  halteId = (await placesNamed(db, "Halte contoh", 5)).find((p) => p.name === "Halte contoh")!.id;
}, 60_000);

afterAll(async () => {
  await close();
});

describe("askAgent", () => {
  it("answers from the chosen place without coordinates, and cites it as a source", async () => {
    const { model, steps } = scripted({ kind: "answer", text: "Ramp tersedia (data terverifikasi AksesBogor, diverifikasi 2026-10-18).", model: "a/satu:free" });
    const result = await askAgent({ model, ctx: ctx() }, { placeId: halteId, question: "Ada ramp?", history: [{ role: "user", content: "Halo" }, { role: "assistant", content: "Halo juga." }] });
    expect(result).toEqual({
      answer: "Ramp tersedia (data terverifikasi AksesBogor, diverifikasi 2026-10-18).",
      model: "a/satu:free",
      sources: [{ type: "lokasi", placeId: halteId, name: "Halte contoh", lastVerifiedAt: "2026-10-18T03:00:00.000Z" }],
    });
    expect(steps[0]!.system).toContain('"name":"Halte contoh"');
    expect(steps[0]!.system).not.toMatch(/"(location|lat|lng)"/);
    expect(steps[0]!.messages).toEqual([
      { role: "user", content: "Halo" },
      { role: "assistant", content: "Halo juga." },
      { role: "user", content: "Ada ramp?" },
    ]);
    expect(steps[0]!.toolChoice).toBe("auto");
  });

  it("runs tool rounds and collects knowledge sources", async () => {
    const { model, steps } = scripted(
      { kind: "tool_calls", calls: [{ id: "c1", name: "search_knowledge", input: { query: "kemiringan ram" } }] },
      { kind: "answer", text: "Kemiringan ram paling besar 1:12." },
    );
    const result = await askAgent({ model, ctx: ctx() }, { placeId: halteId, question: "Berapa kemiringan ram?" });
    expect(result.answer).toBe("Kemiringan ram paling besar 1:12.");
    expect(result.sources).toContainEqual({
      type: "pengetahuan",
      citation: "Permen PUPR No. 14/PRT/M/2017, Lampiran II, B.2 Ram",
      title: "Permen PUPR No. 14/PRT/M/2017",
      url: "https://jdih.pu.go.id/",
      license: "Tanpa hak cipta",
      attribution: null,
    });
    const tool = steps[1]!.messages.at(-1)!;
    expect(tool).toMatchObject({ role: "tool", toolCallId: "c1", name: "search_knowledge" });
    expect(JSON.parse((tool as { content: string }).content).passages[0].citation).toContain("B.2 Ram");
  });

  it("checks tool arguments against the schema and returns errors to the model instead of running the tool", async () => {
    const { model, steps } = scripted(
      {
        kind: "tool_calls",
        calls: [
          { id: "c1", name: "place_accessibility", input: { placeId: "bukan-uuid" } },
          { id: "c2", name: "find_place", input: "{query: halte" },
          { id: "c3", name: "walking_route", input: { from: { lat: -6.6, lng: 106.8 }, placeId: halteId } },
          { id: "c4", name: "place_accessibility", input: { placeId: "00000000-0000-4000-8000-000000000000" } },
        ],
      },
      { kind: "answer", text: "Maaf." },
    );
    await askAgent({ model, ctx: ctx() }, { placeId: halteId, question: "Coba" });
    const results = steps[1]!.messages.filter((m) => m.role === "tool").map((m) => JSON.parse((m as { content: string }).content).galat);
    expect(results).toEqual(["input_tidak_valid", "input_tidak_valid", "alat_tidak_dikenal", "lokasi_tidak_ditemukan"]);
  });

  it("answers 'Belum tahu' places as unknown in the instructions and never sends a route tool", async () => {
    const halteB = (await placesNamed(db, "Halte contoh B", 5)).find((p) => p.name === "Halte contoh B")!.id;
    const { model, steps } = scripted({ kind: "answer", text: "Ramp belum diketahui." });
    await askAgent({ model, ctx: ctx() }, { placeId: halteB, question: "Ada ramp?" });
    expect(steps[0]!.system).toContain('"answer":"belum_tahu"');
    expect(steps[0]!.system).toContain('belum_tahu = belum diketahui');
    expect(steps[0]!.tools.map((t) => t.function.name)).toEqual(["find_place", "place_accessibility", "search_knowledge"]);
  });

  it("stops after the round limit, asking for a final answer without tools", async () => {
    const wantsTools = (): AgentTurn => ({ kind: "tool_calls", calls: [{ id: "c", name: "find_place", input: { query: "halte" } }] });
    const loop = scripted(...Array.from({ length: MAX_TOOL_ROUNDS + 1 }, wantsTools));
    const result = await askAgent({ model: loop.model, ctx: ctx() }, { placeId: halteId, question: "Ulangi terus" });
    expect(result.answer).toBe(NO_ANSWER);
    expect(loop.model.next).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS + 1);
    expect(loop.steps.map((s) => s.toolChoice)).toEqual([...Array(MAX_TOOL_ROUNDS).fill("auto"), "none"]);
  });

  it("refuses tool calls beyond the per-round limit", async () => {
    const calls = Array.from({ length: MAX_CALLS_PER_ROUND + 2 }, (_, i) => ({ id: `c${i}`, name: "find_place", input: { query: "halte" } }));
    const { model, steps } = scripted({ kind: "tool_calls", calls }, { kind: "answer", text: "Oke." });
    await askAgent({ model, ctx: ctx() }, { placeId: halteId, question: "Banyak" });
    const errors = steps[1]!.messages.filter((m) => m.role === "tool" && m.content.includes("terlalu_banyak_panggilan"));
    expect(errors).toHaveLength(2);
  });

  it("removes a sentence that calls the route accessible", async () => {
    const { model } = scripted({ kind: "answer", text: "Toilet difabel tersedia. Rute ke halte ini aksesibel untuk kursi roda." });
    const result = await askAgent({ model, ctx: ctx() }, { placeId: halteId, question: "Rutenya aksesibel kan?" });
    expect(result.answer).toBe(`Toilet difabel tersedia.\n\n${ROUTE_CLAIM_NOTE}`);
  });

  it("passes on a busy model and a missing place", async () => {
    const busy: AgentModel = { next: async () => Promise.reject(new AgentBusyError("kuota")) };
    await expect(askAgent({ model: busy, ctx: ctx() }, { placeId: halteId, question: "Ada lift?" })).rejects.toBeInstanceOf(AgentBusyError);
    const { model } = scripted();
    await expect(askAgent({ model, ctx: ctx() }, { placeId: "00000000-0000-4000-8000-000000000000", question: "Ada lift?" })).rejects.toMatchObject({ statusCode: 404 });
    expect(model.next).not.toHaveBeenCalled();
  });
});
