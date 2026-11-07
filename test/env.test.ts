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

  it("treats empty Mapbox settings as unset", () => {
    const env = loadEnv({ DATABASE_URL: "postgresql://test:test@localhost:5432/test", MAPBOX_SECRET_TOKEN: "", MAPBOX_USERNAME: "" });
    expect(env.MAPBOX_SECRET_TOKEN).toBeUndefined();
    expect(env.MAPBOX_USERNAME).toBeUndefined();
  });

  it("needs the Mapbox token and username together", () => {
    expect(() => loadEnv({ DATABASE_URL: "postgresql://test:test@localhost:5432/test", MAPBOX_SECRET_TOKEN: "sk.rahasia" })).toThrow(
      /MAPBOX_USERNAME/,
    );
  });

  it("rejects a public token where the secret one belongs", () => {
    expect(() =>
      loadEnv({ DATABASE_URL: "postgresql://test:test@localhost:5432/test", MAPBOX_SECRET_TOKEN: "pk.publik", MAPBOX_USERNAME: "aksesbogor" }),
    ).toThrow(/MAPBOX_SECRET_TOKEN/);
  });

  it("treats empty account settings as unset", () => {
    const env = loadEnv({
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      BETTER_AUTH_SECRET: "",
      BETTER_AUTH_URL: "",
      GOOGLE_CLIENT_ID: "",
      RESEND_API_KEY: "",
      EMAIL_FROM: "",
    });
    expect([env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL, env.GOOGLE_CLIENT_ID, env.RESEND_API_KEY, env.EMAIL_FROM]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("rejects a session secret shorter than 32 characters", () => {
    expect(() => loadEnv({ DATABASE_URL: "postgresql://test:test@localhost:5432/test", BETTER_AUTH_SECRET: "pendek" })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });

  it("needs the Resend key and sender together", () => {
    expect(() => loadEnv({ DATABASE_URL: "postgresql://test:test@localhost:5432/test", RESEND_API_KEY: "re_rahasia" })).toThrow(/EMAIL_FROM/);
  });
});
