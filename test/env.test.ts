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
});
