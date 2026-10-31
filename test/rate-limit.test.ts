import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";

const env = loadEnv({ NODE_ENV: "test", DATABASE_URL: "postgresql://test:test@localhost:5432/test" });

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

// /openapi.json tidak butuh database, jadi cocok untuk menghitung kuota.
const hit = (headers: Record<string, string>) => app.inject({ method: "GET", url: "/openapi.json", headers });
const remaining = (res: Awaited<ReturnType<typeof hit>>) => Number(res.headers["x-ratelimit-remaining"]);

describe("rate limit key", () => {
  it("counts by cf-connecting-ip and ignores X-Forwarded-For", async () => {
    const first = await hit({ "cf-connecting-ip": "203.0.113.10", "x-forwarded-for": "198.51.100.1" });
    const second = await hit({ "cf-connecting-ip": "203.0.113.10", "x-forwarded-for": "198.51.100.2" });
    expect(remaining(second)).toBe(remaining(first) - 1);
  });

  it("gives each cf-connecting-ip its own quota", async () => {
    await hit({ "cf-connecting-ip": "203.0.113.20" });
    const other = await hit({ "cf-connecting-ip": "203.0.113.21" });
    expect(remaining(other)).toBe(119);
  });

  it("falls back to the request ip without cf-connecting-ip", async () => {
    const first = await hit({ "x-forwarded-for": "198.51.100.30" });
    const second = await hit({ "x-forwarded-for": "198.51.100.30" });
    expect(remaining(second)).toBe(remaining(first) - 1);
  });

  it("ignores a cf-connecting-ip that is not an ip address", async () => {
    const first = await hit({ "cf-connecting-ip": "bukan-ip", "x-forwarded-for": "198.51.100.40" });
    const second = await hit({ "cf-connecting-ip": "bukan-ip-lain", "x-forwarded-for": "198.51.100.40" });
    expect(remaining(second)).toBe(remaining(first) - 1);
  });

  it("answers 429 in the error format once a client rotating X-Forwarded-For uses its quota", async () => {
    for (let i = 0; i < 120; i++) {
      await hit({ "cf-connecting-ip": "203.0.113.50", "x-forwarded-for": `198.51.100.${i % 250}` });
    }
    const res = await hit({ "cf-connecting-ip": "203.0.113.50", "x-forwarded-for": "198.51.100.251" });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ galat: "terlalu_sering", pesan: expect.any(String) });
  });
});
