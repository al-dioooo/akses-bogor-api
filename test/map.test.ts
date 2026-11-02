import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";

const base = { NODE_ENV: "test", DATABASE_URL: "postgresql://test:test@localhost:5432/test" };
const now = () => new Date("2026-11-02T03:00:00.000Z");

let app: Awaited<ReturnType<typeof buildApp>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(env: Record<string, string>, fetch?: typeof globalThis.fetch) {
  app = await buildApp(loadEnv({ ...base, ...env }), { now, fetch });
  return app;
}

const configured = { MAPBOX_SECRET_TOKEN: "sk.rahasia", MAPBOX_USERNAME: "aksesbogor" };

describe("GET /map/token", () => {
  it("answers 503 while Mapbox is not configured", async () => {
    const res = await (await start({})).inject({ method: "GET", url: "/map/token" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ galat: "peta_belum_diatur", pesan: expect.any(String) });
  });

  it("returns a temporary token that is not cached by browsers", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ token: "tk.sementara" }));
    const res = await (await start(configured, fetch)).inject({ method: "GET", url: "/map/token" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ token: "tk.sementara", expiresAt: "2026-11-02T03:55:00.000Z" });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).not.toContain("sk.rahasia");
  });

  it("shares one token between visitors", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ token: "tk.sementara" }));
    const server = await start(configured, fetch);
    await server.inject({ method: "GET", url: "/map/token" });
    await server.inject({ method: "GET", url: "/map/token" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("answers 502 when Mapbox refuses", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ message: "Not Authorized" }, { status: 401 }));
    const res = await (await start(configured, fetch)).inject({ method: "GET", url: "/map/token" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ galat: "peta_tidak_tersedia", pesan: expect.any(String) });
  });
});
