import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";

const env = loadEnv({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test",
  FRONTEND_ORIGINS: "https://aksesbogor.id",
});

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("GET /healthz", () => {
  it("returns ok", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("unknown routes", () => {
  it("answer 404 in the error format", async () => {
    const res = await app.inject({ method: "GET", url: "/tidak-ada" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ galat: "tidak_ditemukan", pesan: expect.any(String) });
  });
});

describe("CORS", () => {
  it("allows a configured origin", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz", headers: { origin: "https://aksesbogor.id" } });
    expect(res.headers["access-control-allow-origin"]).toBe("https://aksesbogor.id");
  });

  it("does not allow other origins", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz", headers: { origin: "https://contoh.com" } });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("GET /openapi.json", () => {
  it("documents the healthz route", async () => {
    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    const spec = res.json();
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.paths["/healthz"].get.tags).toEqual(["Sistem"]);
  });
});
