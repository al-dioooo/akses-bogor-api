import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_CALLS_PER_ROUND, MAX_TOOL_ROUNDS, NO_ANSWER, askAgent } from "../src/agent/ask.js";
import { AgentBusyError, type AgentModel, type AgentStep, type AgentTurn } from "../src/agent/model.js";
import { ROUTE_CLAIM_NOTE } from "../src/agent/prompt.js";
import type { Db } from "../src/db/client.js";
import { seedSampleData } from "../src/db/seed.js";
import { insertPassages, replaceSource } from "../src/knowledge/store.js";
import { loadDisabilityCounts, parseDisabilityCounts } from "../src/contribute/disability.js";
import { loadFacilities, parseFacilities } from "../src/contribute/facilities.js";
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
      cards: [],
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

  it("answers a contributor without a chosen place", async () => {
    const { model, steps } = scripted({ kind: "answer", text: "Coba mulai dari kecamatan prioritas." });
    const result = await askAgent({ model, ctx: ctx() }, { question: "Saya mau bantu memetakan, mulai dari mana?" });
    expect(result).toEqual({ answer: "Coba mulai dari kecamatan prioritas.", sources: [], model: null, cards: [] });
    expect(steps[0]!.system).toContain("untuk kontributor");
    expect(steps[0]!.system).not.toContain("Tempat yang sedang dilihat");
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
    expect(tool).not.toHaveProperty("isError");
    expect(JSON.parse((tool as { content: string }).content).passages[0].citation).toContain("B.2 Ram");
  });

  it("hands the provider's own blocks of a tool round back unchanged on the next step", async () => {
    const raw = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_use", id: "c1", name: "find_place", input: { query: "halte" } }];
    const { model, steps } = scripted({ kind: "tool_calls", calls: [{ id: "c1", name: "find_place", input: { query: "halte" } }], raw }, { kind: "answer", text: "Ada." });
    await askAgent({ model, ctx: ctx() }, { question: "Ada halte?" });
    expect(steps[1]!.messages.at(-2)).toEqual({ role: "assistant", content: "", toolCalls: [{ id: "c1", name: "find_place", input: { query: "halte" } }], raw });
    // Riwayat hanya bertambah di belakang: langkah kedua diawali persis dengan pesan langkah pertama.
    expect(steps[1]!.messages.slice(0, steps[0]!.messages.length)).toEqual(steps[0]!.messages);
  });

  it("answers with the fixed reply when the model refuses or is cut off, without another step", async () => {
    for (const reason of ["ditolak", "terpotong", "kosong"] as const) {
      const { model } = scripted({ kind: "no_answer", reason, model: "claude-haiku-5-5" });
      const result = await askAgent({ model, ctx: ctx() }, { placeId: halteId, question: "Ada ramp?" });
      expect(result).toMatchObject({ answer: NO_ANSWER, model: "claude-haiku-5-5", cards: [] });
      expect(model.next).toHaveBeenCalledTimes(1);
    }
  });

  it("looks the regulation up and asks again when the model cites one from memory", async () => {
    const { model, steps } = scripted(
      { kind: "answer", text: "Menurut Permen PUPR, kemiringan ram paling besar 1:12." },
      { kind: "answer", text: "Menurut Permen PUPR No. 14/PRT/M/2017, Lampiran II, B.2 Ram, kemiringan ram paling besar 1:12." },
    );
    const result = await askAgent({ model, ctx: ctx() }, { placeId: halteId, question: "Berapa kemiringan ram menurut peraturan?" });
    expect(model.next).toHaveBeenCalledTimes(2);
    expect(steps[1]!.messages.at(-2)).toMatchObject({ role: "assistant", toolCalls: [{ name: "search_knowledge", input: { query: "Berapa kemiringan ram menurut peraturan?" } }] });
    expect(steps[1]!.messages.at(-1)).toMatchObject({ role: "tool", name: "search_knowledge" });
    expect(result.answer).toContain("Lampiran II, B.2 Ram");
    expect(result.sources.some((s) => s.type === "pengetahuan")).toBe(true);
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
    const results = steps[1]!.messages.filter((m) => m.role === "tool");
    expect(results.map((m) => JSON.parse(m.content).galat)).toEqual(["input_tidak_valid", "input_tidak_valid", "alat_tidak_dikenal", "lokasi_tidak_ditemukan"]);
    expect(results.every((m) => m.isError === true)).toBe(true);
  });

  it("answers 'Belum tahu' places as unknown in the instructions and never sends a route tool", async () => {
    const halteB = (await placesNamed(db, "Halte contoh B", 5)).find((p) => p.name === "Halte contoh B")!.id;
    const { model, steps } = scripted({ kind: "answer", text: "Ramp belum diketahui." });
    await askAgent({ model, ctx: ctx() }, { placeId: halteB, question: "Ada ramp?" });
    expect(steps[0]!.system).toContain('"answer":"belum_tahu"');
    expect(steps[0]!.system).toContain('belum_tahu = belum diketahui');
    expect(steps[0]!.tools.map((t) => t.function.name)).not.toContain("walking_route");
    expect(steps[0]!.tools.map((t) => t.function.name)).not.toContain("route_obstacles");
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
    expect(errors.every((m) => m.role === "tool" && m.isError)).toBe(true);
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

  it("shows place and route cards to the web while the model only gets a short confirmation", async () => {
    await loadFacilities(db, parseFacilities({ elements: [{ type: "node", id: 77, lat: -6.5705, lon: 106.7645, tags: { amenity: "hospital", name: "RS Barat" } }] }), {
      url: "https://overpass-api.de/api/interpreter",
      retrievedAt: now(),
      sha256: "a".repeat(64),
    });
    const { model, steps } = scripted(
      {
        kind: "tool_calls",
        calls: [
          { id: "k1", name: "show_place_card", input: { osmType: "node", osmId: 77 } },
          { id: "k2", name: "show_route_card", input: { placeId: halteId } },
        ],
      },
      { kind: "answer", text: "Kartu tempat dan rute sudah tampil." },
    );
    const result = await askAgent({ model, ctx: ctx() }, { question: "Tunjukkan RS Barat dan rute ke Halte contoh" });
    expect(result.cards).toEqual([
      {
        type: "tempat",
        target: { kind: "osm", osmType: "node", osmId: 77 },
        name: "RS Barat",
        category: "rumah_sakit",
        district: { slug: "bogor-barat", name: "Bogor Barat" },
        location: { lat: -6.5705, lng: 106.7645 },
        osmUrl: "https://www.openstreetmap.org/node/77",
        attribution: expect.stringContaining("OpenStreetMap"),
      },
      { type: "rute", target: { kind: "aksesbogor", placeId: halteId }, name: "Halte contoh" },
    ]);
    const toolResults = steps[1]!.messages.filter((m) => m.role === "tool").map((m) => JSON.parse((m as { content: string }).content));
    expect(toolResults).toEqual([{ pesan: "Kartu tempat ditampilkan untuk RS Barat." }, { pesan: expect.stringContaining("Kartu rute ditampilkan untuk Halte contoh") }]);
    expect(JSON.stringify(steps[1]!.messages)).not.toMatch(/-6\.57|106\.76|"location"/);
  });

  it("accepts the model's text with card calls without another model step", async () => {
    const { model } = scripted({ kind: "tool_calls", text: "Ini kartunya.", calls: [{ id: "k1", name: "show_place_card", input: { placeId: halteId } }] });
    const result = await askAgent({ model, ctx: ctx() }, { question: "Tunjukkan Halte contoh" });
    expect(model.next).toHaveBeenCalledTimes(1);
    expect(result.answer).toBe("Ini kartunya.");
    expect(result.cards).toMatchObject([{ type: "tempat", target: { kind: "aksesbogor", placeId: halteId }, status: "sebagian" }]);
  });

  it("rejects a card call without exactly one target", async () => {
    const { model, steps } = scripted({ kind: "tool_calls", calls: [{ id: "k1", name: "show_route_card", input: { placeId: halteId, osmType: "node", osmId: 77 } }] }, { kind: "answer", text: "Maaf." });
    const result = await askAgent({ model, ctx: ctx() }, { question: "Rute" });
    expect(result.cards).toEqual([]);
    expect(JSON.parse((steps[1]!.messages.at(-1) as { content: string }).content).galat).toBe("input_tidak_valid");
  });

  it("shows the priority card and cites the open data source", async () => {
    const slugs = ["bogor-barat", "bogor-selatan", "bogor-tengah", "bogor-timur", "bogor-utara", "tanah-sareal"];
    const rows = slugs.map((slug) => ({ bps_nama_kecamatan: slug.replace("-", " ").toUpperCase(), jenis_disabilitas: "CACAT NETRA", jumlah: 3, tahun: 2024 }));
    await loadDisabilityCounts(db, parseDisabilityCounts({ data: rows }, slugs), { retrievedAt: now(), sha256: "d".repeat(64) });
    const { model } = scripted({ kind: "tool_calls", calls: [{ id: "p1", name: "kecamatan_priority", input: {} }] }, { kind: "answer", text: "Mulai dari peringkat pertama." });
    const result = await askAgent({ model, ctx: { db, now, disabilityData: true } }, { question: "Kecamatan mana dulu?" });
    expect(result.cards).toMatchObject([{ type: "prioritas", year: 2024 }]);
    expect(result.sources).toContainEqual(expect.objectContaining({ type: "pengetahuan", citation: expect.stringContaining("Penyandang Disabilitas"), attribution: expect.stringContaining("Dinas Sosial") }));
  });
});

