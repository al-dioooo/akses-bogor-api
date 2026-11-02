import { describe, expect, it, vi } from "vitest";
import { mapTokenSource } from "../src/map/token.js";

const start = new Date("2026-11-02T03:00:00.000Z");

function setup(responses: (() => Response)[]) {
  let time = start.getTime();
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    const next = responses.shift();
    if (!next) throw new Error("tidak ada respons tiruan");
    return next();
  });
  const source = mapTokenSource({ secretToken: "sk.rahasia", username: "aksesbogor", now: () => new Date(time), fetch });
  return { source, fetch, advance: (minutes: number) => (time += minutes * 60_000) };
}

const minted = (token: string) => () => Response.json({ token });

describe("mapTokenSource", () => {
  it("asks Mapbox for a 55-minute token with the map scopes", async () => {
    const { source, fetch } = setup([minted("tk.satu")]);
    await expect(source()).resolves.toEqual({ token: "tk.satu", expiresAt: "2026-11-02T03:55:00.000Z" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.mapbox.com/tokens/v2/aksesbogor?access_token=sk.rahasia");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      expires: "2026-11-02T03:55:00.000Z",
      scopes: ["styles:read", "styles:tiles", "fonts:read"],
    });
  });

  it("reuses a token until 15 minutes are left, then makes a new one", async () => {
    const { source, fetch, advance } = setup([minted("tk.satu"), minted("tk.dua")]);
    await source();
    advance(39);
    await expect(source()).resolves.toMatchObject({ token: "tk.satu" });
    advance(1);
    await expect(source()).resolves.toMatchObject({ token: "tk.dua" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("makes one token for requests that arrive together", async () => {
    const { source, fetch } = setup([minted("tk.satu")]);
    const tokens = await Promise.all([source(), source(), source()]);
    expect(tokens.map((t) => t.token)).toEqual(["tk.satu", "tk.satu", "tk.satu"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fails without leaking the secret token, and tries again on the next call", async () => {
    const { source } = setup([
      () => Response.json({ message: "Not Authorized" }, { status: 401 }),
      () => {
        throw new TypeError("fetch failed https://api.mapbox.com/tokens/v2/aksesbogor?access_token=sk.rahasia");
      },
      minted("tk.satu"),
    ]);
    await expect(source()).rejects.toThrow("Mapbox Tokens API menjawab 401");
    const offline = await source().catch((error: Error) => error.message);
    expect(offline).toBe("Mapbox Tokens API tidak bisa dihubungi");
    await expect(source()).resolves.toMatchObject({ token: "tk.satu" });
  });
});
