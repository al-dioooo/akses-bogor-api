import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";

describe("loadEnv", () => {
  it("names the missing variables", () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });

  it("splits FRONTEND_ORIGINS on commas", () => {
    const env = loadEnv({
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      FRONTEND_ORIGINS: "https://aksesbogor.id, http://localhost:3000,",
    });
    expect(env.FRONTEND_ORIGINS).toEqual(["https://aksesbogor.id", "http://localhost:3000"]);
    expect(env.PORT).toBe(8080);
  });

  it("treats an empty PHOTO_PUBLIC_URL as unset, as in .env.example", () => {
    const env = loadEnv({ DATABASE_URL: "postgresql://test:test@localhost:5432/test", PHOTO_PUBLIC_URL: "" });
    expect(env.PHOTO_PUBLIC_URL).toBeUndefined();
  });

  it("treats an empty WEB_SERVER_SECRET as unset and rejects a short one", () => {
    const base = { DATABASE_URL: "postgresql://test:test@localhost:5432/test" };
    expect(loadEnv({ ...base, WEB_SERVER_SECRET: "" }).WEB_SERVER_SECRET).toBeUndefined();
    expect(() => loadEnv({ ...base, WEB_SERVER_SECRET: "pendek" })).toThrow(/WEB_SERVER_SECRET/);
  });
});
