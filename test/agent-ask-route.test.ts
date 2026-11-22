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
  OPENROUTER_MODELS: "a/satu:free,b/dua:free,c/tiga:free,d/empat:free",
};
const NOW = new Date("2026-11-22T05:00:00.000Z");

/** Jawaban OpenRouter tiruan, dipakai berurutan. */
let replies: (() => Response)[] = [];
const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
  if (String(url) !== OPENROUTER_URL) throw new Error(`alamat tak terduga ${String(url)}`);
  const reply = replies.shift();
  if (!reply) throw new Error("permintaan OpenRouter tak terduga");
  return reply();
});
const answer = (content: string, model = "a/satu:free") => () => Response.json({ model, choices: [{ finish_reason: "stop", message: { content } }] });
const toolCall = (name: string, args: string, id = "c1") => () =>
  Response.json({ model: "a/satu:free", choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id, type: "function", function: { name, arguments: args } }] } }] });
const failure = (status: number, metadata?: Record<string, unknown>) => () => Response.json({ error: { code: status, message: "galat", metadata } }, { status });
const sentBody = (call: number) => JSON.parse((fetch.mock.calls[call]![1] as RequestInit).body as string);

let db: Db;
let close: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let disabled: Awaited<ReturnType<typeof buildApp>>;
let keyless: Awaited<ReturnType<typeof buildApp>>;
let sari: { token: string };
let budi: { token: string };
let dewi: { token: string };
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
  await Promise.all([app.ready(), disabled.ready(), keyless.ready()]);
  const helpers = accounts(app, sent);
  sari = await helpers.reporter("sari@contoh.id", "Sari");
  budi = await helpers.reporter("budi@contoh.id", "Budi");
  dewi = await helpers.reporter("dewi@contoh.id", "Dewi");
  halteId = (await placesNamed(db, "Halte contoh", 5)).find((p) => p.name === "Halte contoh")!.id;
}, 60_000);

afterAll(async () => {
  await Promise.all([app.close(), disabled.close(), keyless.close()]);
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

  it("is busy without an OpenRouter key", async () => {
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

  it("validates the question, the history and the place", async () => {
    expect((await ask(sari.token, { placeId: halteId, question: "x" })).statusCode).toBe(400);
    const long = Array.from({ length: 7 }, () => ({ role: "user", content: "Halo" }));
    expect((await ask(sari.token, { placeId: halteId, question: "Ada ramp?", history: long })).statusCode).toBe(400);
    expect((await ask(sari.token, { placeId: "00000000-0000-4000-8000-000000000000", question: "Ada ramp?" })).statusCode).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
});
