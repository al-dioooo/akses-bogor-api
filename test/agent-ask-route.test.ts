import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TOOL_ROUNDS, NO_ANSWER } from "../src/agent/ask.js";
import { QUESTIONS_PER_ACCOUNT_PER_DAY } from "../src/agent/limits.js";
import { OPENROUTER_URL } from "../src/agent/openrouter.js";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import type { Db } from "../src/db/client.js";
import { seedSampleData } from "../src/db/seed.js";
import type { Email, Mailer } from "../src/email/mailer.js";
import { insertPassages, replaceSource } from "../src/knowledge/store.js";
import { placesNamed } from "../src/places/queries.js";
import { accounts } from "./helpers/accounts.js";
import { createTestDb } from "./helpers/db.js";

const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test@localhost/test",
  BETTER_AUTH_SECRET: "rahasia-tes-yang-panjangnya-lebih-dari-32-karakter",
  ROUTE_AGENT_ENABLED: "true",
  AGENT_PROVIDER: "openrouter",
  OPENROUTER_MODELS: "a/satu:free,b/dua:free,c/tiga:free,d/empat:free",
};
const CLAUDE_URL = "https://api.anthropic.com/v1/messages";
const NOW = new Date("2026-11-22T05:00:00.000Z");

/** Jawaban OpenRouter tiruan, dipakai berurutan. */
let replies: (() => Response)[] = [];
const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
  if (String(url) !== OPENROUTER_URL && String(url) !== CLAUDE_URL) throw new Error(`alamat tak terduga ${String(url)}`);
  const reply = replies.shift();
  if (!reply) throw new Error("permintaan OpenRouter tak terduga");
  return reply();
});
const answer = (content: string, model = "a/satu:free") => () => Response.json({ model, choices: [{ finish_reason: "stop", message: { content } }] });
const toolCall = (name: string, args: string, id = "c1") => () =>
  Response.json({ model: "a/satu:free", choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id, type: "function", function: { name, arguments: args } }] } }] });
const failure = (status: number, metadata?: Record<string, unknown>) => () => Response.json({ error: { code: status, message: "galat", metadata } }, { status });
const sentBody = (call: number) => JSON.parse((fetch.mock.calls[call]![1] as RequestInit).body as string);
/** Jawaban Claude API tiruan. */
const claude = (content: unknown[], stop_reason: string) => () =>
  Response.json({ id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content, stop_reason, stop_details: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } });
const claudeFailure = (status: number, type: string) => () =>
  Response.json({ type: "error", error: { type, message: "galat" } }, { status, headers: { "retry-after-ms": "1" } });

let db: Db;
let close: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let disabled: Awaited<ReturnType<typeof buildApp>>;
let keyless: Awaited<ReturnType<typeof buildApp>>;
let claudeApp: Awaited<ReturnType<typeof buildApp>>;
let claudeKeyless: Awaited<ReturnType<typeof buildApp>>;
let claudeBothKeys: Awaited<ReturnType<typeof buildApp>>;
let sari: { token: string };
let budi: { token: string };
let dewi: { token: string };
let rina: { token: string };
let halteId: string;
const sent: Email[] = [];
const mailer: Mailer = async (email) => {
  sent.push(email);
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedSampleData(db);
  const source = { id: "uu-8-2016", kind: "regulasi" as const, title: "UU No. 8 Tahun 2016", url: "https://peraturan.go.id/files/uu8-2016bt.pdf", license: "Tanpa hak cipta", retrievedAt: NOW };
  await replaceSource(db, source, (tx) => insertPassages(tx, source.id, [{ citation: "UU No. 8 Tahun 2016, Pasal 18", body: "Hak Aksesibilitas untuk fasilitas publik." }]));
  const deps = { db, mailer, fetch, now: () => NOW };
  app = await buildApp(loadEnv({ ...base, OPENROUTER_API_KEY: "sk-or-tes" }), deps);
  disabled = await buildApp(loadEnv({ ...base, ROUTE_AGENT_ENABLED: "false", OPENROUTER_API_KEY: "sk-or-tes" }), deps);
  keyless = await buildApp(loadEnv(base), deps);
  const claudeBase = { ...base, AGENT_PROVIDER: "anthropic" };
  claudeApp = await buildApp(loadEnv({ ...claudeBase, ANTHROPIC_API_KEY: "sk-ant-tes" }), deps);
  claudeKeyless = await buildApp(loadEnv(claudeBase), deps);
  claudeBothKeys = await buildApp(loadEnv({ ...claudeBase, ANTHROPIC_API_KEY: "sk-ant-tes", OPENROUTER_API_KEY: "sk-or-tes" }), deps);
  await Promise.all([app.ready(), disabled.ready(), keyless.ready(), claudeApp.ready(), claudeKeyless.ready(), claudeBothKeys.ready()]);
  const helpers = accounts(app, sent);
  sari = await helpers.reporter("sari@contoh.id", "Sari");
  budi = await helpers.reporter("budi@contoh.id", "Budi");
  dewi = await helpers.reporter("dewi@contoh.id", "Dewi");
  rina = await helpers.reporter("rina@contoh.id", "Rina");
  halteId = (await placesNamed(db, "Halte contoh", 5)).find((p) => p.name === "Halte contoh")!.id;
}, 60_000);

afterAll(async () => {
  await Promise.all([app.close(), disabled.close(), keyless.close(), claudeApp.close(), claudeKeyless.close(), claudeBothKeys.close()]);
  await close();
});

beforeEach(() => {
  fetch.mockClear();
  replies = [];
});

let ip = 0;
const ask = (token: string | null, payload: object, target = app) =>
  target.inject({ method: "POST", url: "/agent/ask", payload, headers: token ? { authorization: `Bearer ${token}` } : {}, remoteAddress: `203.0.113.${(ip++ % 250) + 1}` });

describe("POST /agent/ask", () => {
  it("stays closed while ROUTE_AGENT_ENABLED is off, and needs a session", async () => {
    const off = await ask(sari.token, { placeId: halteId, question: "Ada ramp?" }, disabled);
    expect(off.statusCode).toBe(503);
    expect(off.json().galat).toBe("agen_rute_belum_aktif");
    expect((await ask(null, { placeId: halteId, question: "Ada ramp?" })).statusCode).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is busy without an OpenRouter key when OpenRouter is chosen", async () => {
    const res = await ask(sari.token, { placeId: halteId, question: "Ada ramp?" }, keyless);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ galat: "agen_sibuk", pesan: "Agen sedang sibuk, coba lagi nanti." });
  });

  it("runs a tool round and answers with the sources it read, never sending coordinates to the model", async () => {
    replies = [toolCall("search_knowledge", '{"query":"hak aksesibilitas"}'), answer("Menurut UU No. 8 Tahun 2016, Pasal 18, ...", "b/dua:free")];
    const res = await ask(sari.token, { placeId: halteId, question: "Apa hak aksesibilitas saya?", history: [{ role: "user", content: "Halo" }] });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toMatchObject({
      answer: "Menurut UU No. 8 Tahun 2016, Pasal 18, ...",
      model: "b/dua:free",
      sources: [
        { type: "lokasi", placeId: halteId, name: "Halte contoh" },
        { type: "pengetahuan", citation: "UU No. 8 Tahun 2016, Pasal 18", license: "Tanpa hak cipta" },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const call of [0, 1]) expect(JSON.stringify(sentBody(call))).not.toMatch(/"(lat|lng|location|geometry|polyline)"|-6\.59|106\.79/);
    expect(sentBody(1).messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1" });
  });

  it("returns cards for the web and only a confirmation to the model", async () => {
    replies = [toolCall("show_route_card", JSON.stringify({ placeId: halteId })), answer("Kartu rute ke Halte contoh sudah tampil.")];
    const res = await ask(rina.token, { question: "Tunjukkan rute ke Halte contoh" });
    expect(res.statusCode).toBe(200);
    expect(res.json().cards).toEqual([{ type: "rute", target: { kind: "aksesbogor", placeId: halteId }, name: "Halte contoh" }]);
    expect(JSON.parse(sentBody(1).messages.at(-1).content)).toEqual({ pesan: expect.stringContaining("Kartu rute ditampilkan untuk Halte contoh") });
  });

  it("returns invalid tool arguments to the model as an error instead of running the tool", async () => {
    replies = [toolCall("place_accessibility", '{"placeId":"bukan-uuid"}'), answer("Maaf, saya tidak menemukan tempat itu.")];
    const res = await ask(sari.token, { placeId: halteId, question: "Bagaimana dengan tempat lain?" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(sentBody(1).messages.at(-1).content)).toMatchObject({ galat: "input_tidak_valid" });
  });

  it("falls back to the next group of models when the first group is rate-limited upstream", async () => {
    replies = [failure(429, { provider_name: "Google AI Studio", raw: "temporarily rate-limited upstream" }), answer("Lift tidak perlu di halte ini.", "d/empat:free")];
    const res = await ask(sari.token, { placeId: halteId, question: "Ada lift?" });
    expect(res.statusCode).toBe(200);
    expect(res.json().model).toBe("d/empat:free");
    expect(sentBody(0).models).toEqual(["a/satu:free", "b/dua:free", "c/tiga:free"]);
    expect(sentBody(1).models).toEqual(["d/empat:free"]);
  });

  it("answers busy on the OpenRouter account limit or missing credit, without using the account's daily questions", async () => {
    for (const status of [429, 402]) {
      replies = [failure(status)];
      const res = await ask(dewi.token, { placeId: halteId, question: "Ada toilet difabel?" });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ galat: "agen_sibuk", pesan: "Agen sedang sibuk, coba lagi nanti." });
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    for (let i = 0; i < QUESTIONS_PER_ACCOUNT_PER_DAY; i += 1) {
      replies = [answer("Oke.")];
      expect((await ask(dewi.token, { placeId: halteId, question: "Ada toilet difabel?" })).statusCode).toBe(200);
    }
  });

  it("stops after the tool round limit with a fixed answer", async () => {
    replies = Array.from({ length: MAX_TOOL_ROUNDS + 1 }, () => toolCall("find_place", '{"query":"halte"}'));
    const res = await ask(budi.token, { placeId: halteId, question: "Cari terus" });
    expect(res.statusCode).toBe(200);
    expect(res.json().answer).toBe(NO_ANSWER);
    expect(fetch).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS + 1);
    expect(sentBody(MAX_TOOL_ROUNDS).tool_choice).toBe("none");
  });

  it("limits questions per account per day", async () => {
    // Budi sudah bertanya sekali di tes sebelumnya.
    for (let i = 1; i < QUESTIONS_PER_ACCOUNT_PER_DAY; i += 1) {
      replies = [answer("Oke.")];
      expect((await ask(budi.token, { placeId: halteId, question: "Ada ramp?" })).statusCode).toBe(200);
    }
    const refused = await ask(budi.token, { placeId: halteId, question: "Ada ramp?" });
    expect(refused.statusCode).toBe(429);
    expect(refused.json().galat).toBe("agen_terlalu_sering");
  });

  it("answers without a chosen place", async () => {
    replies = [answer("Mulai dari kecamatan prioritas.")];
    const res = await ask(sari.token, { question: "Saya mau bantu memetakan, mulai dari mana?" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ answer: "Mulai dari kecamatan prioritas.", sources: [] });
    expect(sentBody(0).messages[0].content).not.toContain("Tempat yang sedang dilihat");
  });

  it("asks Claude when it is the provider, replaying its blocks with the tool results and never sending coordinates", async () => {
    const thinking = { type: "thinking", thinking: "", signature: "sig" };
    const call = { type: "tool_use", id: "toolu_1", name: "search_knowledge", input: { query: "hak aksesibilitas" } };
    replies = [claude([thinking, call], "tool_use"), claude([{ type: "text", text: "Menurut UU No. 8 Tahun 2016, Pasal 18, ..." }], "end_turn")];
    const res = await ask(sari.token, { placeId: halteId, question: "Apa hak aksesibilitas saya?" }, claudeApp);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ answer: "Menurut UU No. 8 Tahun 2016, Pasal 18, ...", model: "claude-haiku-5-5" });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([CLAUDE_URL, CLAUDE_URL]);
    for (const n of [0, 1]) expect(JSON.stringify(sentBody(n))).not.toMatch(/"(lat|lng|location|geometry|polyline)"|-6\.59|106\.79/);
    expect(sentBody(1).messages.slice(-2)).toEqual([
      { role: "assistant", content: [thinking, call] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: expect.stringContaining("UU No. 8 Tahun 2016, Pasal 18") }] },
    ]);
  });

  it("never falls back to OpenRouter when Claude fails, even with both keys set", async () => {
    const cases = [
      [401, "authentication_error"],
      [429, "rate_limit_error"],
      [529, "overloaded_error"],
    ] as const;
    for (const [status, type] of cases) {
      // Dua jawaban gagal: SDK mengulang sekali untuk 429 dan 529.
      replies = [claudeFailure(status, type), claudeFailure(status, type)];
      const res = await ask(rina.token, { question: "Mulai dari mana?" }, claudeBothKeys);
      expect(res.statusCode).toBe(503);
      expect(res.json().galat).toBe("agen_sibuk");
    }
    // 401 sekali, 429 dan 529 masing-masing dua kali; tidak satu pun ke OpenRouter.
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(Array(5).fill(CLAUDE_URL));
  });

  it("is busy without a Claude key, without calling the API or using the account's daily questions", async () => {
    for (let i = 0; i <= QUESTIONS_PER_ACCOUNT_PER_DAY; i += 1) {
      const res = await ask(rina.token, { question: "Mulai dari mana?" }, claudeKeyless);
      expect(res.statusCode).toBe(503);
      expect(res.json().galat).toBe("agen_sibuk");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("validates the question, the history and the place", async () => {
    expect((await ask(sari.token, { placeId: halteId, question: "x" })).statusCode).toBe(400);
    const long = Array.from({ length: 7 }, () => ({ role: "user", content: "Halo" }));
    expect((await ask(sari.token, { placeId: halteId, question: "Ada ramp?", history: long })).statusCode).toBe(400);
    expect((await ask(sari.token, { placeId: "00000000-0000-4000-8000-000000000000", question: "Ada ramp?" })).statusCode).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
});
