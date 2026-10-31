import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";

const base = { NODE_ENV: "test", DATABASE_URL: "postgresql://test:test@localhost:5432/test" };
const secret = "rahasia-uji-yang-panjangnya-lebih-dari-32-karakter";

let app: Awaited<ReturnType<typeof buildApp>>;
let webApp: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp(loadEnv(base));
  webApp = await buildApp(loadEnv({ ...base, WEB_SERVER_SECRET: secret }));
  await Promise.all([app.ready(), webApp.ready()]);
});

afterAll(async () => {
  await Promise.all([app.close(), webApp.close()]);
});

// /openapi.json tidak butuh database, jadi cocok untuk menghitung kuota.
const request = (target: typeof app, headers: Record<string, string>) =>
  target.inject({ method: "GET", url: "/openapi.json", headers });
const hit = (headers: Record<string, string>) => request(app, headers);
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

// Panggilan dari server Next.js lewat Cloudflare: cf-connecting-ip selalu IP egress Vercel.
describe("web server calls", () => {
  it("count by the visitor ip when the secret matches", async () => {
    const vercel = { "cf-connecting-ip": "192.0.2.1" };
    await request(webApp, { ...vercel, "x-web-server-secret": secret, "x-visitor-ip": "198.51.100.60" });
    const other = await request(webApp, { ...vercel, "x-web-server-secret": secret, "x-visitor-ip": "2001:db8::61" });
    expect(remaining(other)).toBe(119);
  });

  it("share the cf-connecting-ip quota when the secret is wrong", async () => {
    const vercel = { "cf-connecting-ip": "192.0.2.2" };
    const first = await request(webApp, { ...vercel, "x-web-server-secret": "salah", "x-visitor-ip": "198.51.100.70" });
    const second = await request(webApp, { ...vercel, "x-web-server-secret": "salah", "x-visitor-ip": "198.51.100.71" });
    expect(remaining(second)).toBe(remaining(first) - 1);
  });

  it("share the cf-connecting-ip quota when no secret is configured", async () => {
    const vercel = { "cf-connecting-ip": "192.0.2.3" };
    const first = await request(app, { ...vercel, "x-web-server-secret": secret, "x-visitor-ip": "198.51.100.80" });
    const second = await request(app, { ...vercel, "x-web-server-secret": secret, "x-visitor-ip": "198.51.100.81" });
    expect(remaining(second)).toBe(remaining(first) - 1);
  });

  it("fall back to cf-connecting-ip when the visitor ip is not an ip address", async () => {
    const vercel = { "cf-connecting-ip": "192.0.2.4" };
    const first = await request(webApp, { ...vercel, "x-web-server-secret": secret, "x-visitor-ip": "bukan-ip" });
    const second = await request(webApp, { ...vercel, "x-web-server-secret": secret });
    expect(remaining(second)).toBe(remaining(first) - 1);
  });
});
