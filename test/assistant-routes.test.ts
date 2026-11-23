import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QUESTIONS_PER_VISITOR_PER_DAY } from "../src/agent/limits.js";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import type { Db } from "../src/db/client.js";
import { seedSampleData } from "../src/db/seed.js";
import type { Email, Mailer } from "../src/email/mailer.js";
import { placesNamed } from "../src/places/queries.js";
import { accounts } from "./helpers/accounts.js";
import { createTestDb } from "./helpers/db.js";

const base = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test@localhost/test",
  BETTER_AUTH_SECRET: "rahasia-tes-yang-panjangnya-lebih-dari-32-karakter",
  ANTHROPIC_API_KEY: "sk-ant-tes",
};
const NOW = new Date("2026-11-23T05:00:00.000Z");
const CLAUDE_URL = "https://api.anthropic.com/v1/messages";
const COORDINATE = /-6\.\d{3}|106\.\d{3}/;
/** Beberapa meter dari Halte contoh di Bogor Tengah. */
const nearHalte = { lat: -6.59585, lng: 106.79425 };

/** Jawaban Claude API tiruan, dipakai berurutan. */
let replies: (() => Response)[] = [];
const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
  if (String(url) !== CLAUDE_URL) throw new Error(`alamat tak terduga ${String(url)}`);
  const reply = replies.shift();
  if (!reply) throw new Error("permintaan Claude tak terduga");
  return reply();
});
const claude = (content: unknown[], stop_reason: string) => () =>
  Response.json({ id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content, stop_reason, stop_details: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } });
const text = (value: string) => claude([{ type: "text", text: value }], "end_turn");
const tool = (name: string, input: object, id = "t1") => claude([{ type: "tool_use", id, name, input }], "tool_use");
const overloaded = () => Response.json({ type: "error", error: { type: "overloaded_error", message: "galat" } }, { status: 529, headers: { "retry-after-ms": "1" } });
const claudeBodies = () => fetch.mock.calls.filter(([url]) => String(url) === CLAUDE_URL).map(([, init]) => String((init as RequestInit).body));

let db: Db;
let close: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let closed: Awaited<ReturnType<typeof buildApp>>;
let small: Awaited<ReturnType<typeof buildApp>>;
let sari: { token: string };
let halteId: string;
const sent: Email[] = [];
const mailer: Mailer = async (email) => {
  sent.push(email);
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedSampleData(db);
  const deps = { db, mailer, fetch, now: () => NOW };
  app = await buildApp(loadEnv({ ...base, ROUTE_ASSISTANT_ENABLED: "true", ROUTE_AGENT_ENABLED: "true" }), deps);
  closed = await buildApp(loadEnv(base), deps);
  small = await buildApp(loadEnv({ ...base, ROUTE_ASSISTANT_ENABLED: "true", ROUTE_ASSISTANT_QUESTIONS_PER_DAY: "2" }), deps);
  await Promise.all([app.ready(), closed.ready(), small.ready()]);
  sari = await accounts(app, sent).reporter("sari@contoh.id", "Sari");
  halteId = (await placesNamed(db, "Halte contoh", 5)).find((p) => p.name === "Halte contoh")!.id;
}, 60_000);

afterAll(async () => {
  await Promise.all([app.close(), closed.close(), small.close()]);
  await close();
});

beforeEach(() => {
  fetch.mockClear();
  replies = [];
});

let ip = 0;
const nextIp = () => `198.51.100.${(ip++ % 250) + 1}`;
const ask = (payload: object, { target = app, token, from = nextIp() }: { target?: typeof app; token?: string; from?: string } = {}) =>
  target.inject({ method: "POST", url: "/route-assistant/ask", payload, headers: token ? { authorization: `Bearer ${token}` } : {}, remoteAddress: from });

describe("GET /route-assistant/status", () => {
  it("tells the web whether the assistant is open, without a session", async () => {
    expect((await app.inject({ method: "GET", url: "/route-assistant/status" })).json()).toEqual({ enabled: true, questionsPerDay: QUESTIONS_PER_VISITOR_PER_DAY });
    expect((await closed.inject({ method: "GET", url: "/route-assistant/status" })).json()).toMatchObject({ enabled: false });
  });
});

describe("POST /route-assistant/ask", () => {
  it("stays closed while ROUTE_ASSISTANT_ENABLED is off", async () => {
    const res = await ask({ question: "Rute ke halte?" }, { target: closed });
    expect(res.statusCode).toBe(503);
    expect(res.json().galat).toBe("asisten_rute_belum_aktif");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("answers a visitor without an account, keeps the start point on the server, and returns the route card", async () => {
    replies = [tool("nearby_places", { category: "halte" }), tool("show_route", { placeId: halteId }, "t2"), text("Halte contoh sekitar 100 m garis lurus dari titik awal Anda.")];
    const res = await ask({ question: "Halte terdekat dari sini?", from: nearHalte });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toMatchObject({
      answer: "Halte contoh sekitar 100 m garis lurus dari titik awal Anda.",
      model: "claude-haiku-5-5",
      cards: [{ type: "rute", target: { kind: "aksesbogor", placeId: halteId }, name: "Halte contoh" }],
    });
    const bodies = claudeBodies();
    expect(bodies).toHaveLength(3);
    for (const body of bodies) expect(body).not.toMatch(COORDINATE);
    expect(bodies[1]).toContain('\\"distanceMeters\\":100');
    expect(bodies[0]).toContain("Titik awal pengunjung: sudah dipilih");
  });

  it("gives each IP five questions a day, and a failed question does not count", async () => {
    const from = nextIp();
    replies = [overloaded, overloaded];
    const failed = await ask({ question: "Rute ke halte?" }, { from });
    expect(failed.statusCode).toBe(503);
    expect(failed.json().galat).toBe("agen_sibuk");
    for (let i = 0; i < QUESTIONS_PER_VISITOR_PER_DAY; i += 1) {
      replies.push(text("Jawaban."));
      expect((await ask({ question: "Rute ke halte?" }, { from })).statusCode).toBe(200);
    }
    const over = await ask({ question: "Rute ke halte?" }, { from });
    expect(over.statusCode).toBe(429);
    expect(over.json()).toEqual({ galat: "kuota_habis", pesan: "Jatah 5 pertanyaan hari ini sudah habis. Coba lagi besok, atau masuk untuk memakai jatah akun Anda." });
    replies.push(text("Jawaban."));
    expect((await ask({ question: "Rute ke halte?" })).statusCode).toBe(200);
  });

  it("counts a signed-in account on the account quota shared with the contributor agent", async () => {
    for (let i = 0; i < 4; i += 1) {
      replies.push(text("Jawaban."));
      expect((await ask({ question: "Rute ke halte?" }, { token: sari.token })).statusCode).toBe(200);
    }
    replies.push(text("Jawaban."));
    const contributor = await app.inject({ method: "POST", url: "/agent/ask", payload: { question: "Mulai dari mana?" }, headers: { authorization: `Bearer ${sari.token}` }, remoteAddress: nextIp() });
    expect(contributor.statusCode).toBe(200);
    const over = await ask({ question: "Rute ke halte?" }, { token: sari.token });
    expect(over.statusCode).toBe(429);
    expect(over.json()).toEqual({ galat: "kuota_habis", pesan: "Jatah 5 pertanyaan hari ini sudah habis. Coba lagi besok." });
  });

  it("is busy once the daily cap for everyone is reached", async () => {
    replies = [text("Satu."), text("Dua.")];
    expect((await ask({ question: "Rute ke halte?" }, { target: small })).statusCode).toBe(200);
    expect((await ask({ question: "Rute ke halte?" }, { target: small })).statusCode).toBe(200);
    const busy = await ask({ question: "Rute ke halte?" }, { target: small });
    expect(busy.statusCode).toBe(503);
    expect(busy.json()).toEqual({ galat: "agen_sibuk", pesan: "Asisten sedang sibuk. Coba lagi nanti." });
  });

  it("checks the answer for route claims before returning it", async () => {
    replies = [text("Rute ke Halte contoh ramah kursi roda.")];
    const res = await ask({ question: "Rute ke halte?", placeId: halteId });
    expect(res.json().answer).not.toContain("ramah kursi roda.");
  });
});
