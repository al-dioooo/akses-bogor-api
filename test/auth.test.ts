import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { createAuth, type Auth } from "../src/auth/auth.js";
import { createTestDb } from "./helpers/db.js";
import { googleCertsFetch, googleIdToken } from "./helpers/google.js";

// Better Auth sendiri, tanpa route Fastify: apa yang disimpan di database (ADR-0029).
let auth: Auth;
let client: PGlite;
let close: () => Promise<void>;

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  close = test.close;
  auth = createAuth({
    db: test.db,
    secret: "rahasia-tes-yang-panjangnya-lebih-dari-32-karakter",
    baseURL: "http://localhost:8080",
    googleClientId: "client-tes",
  });
  vi.stubGlobal("fetch", googleCertsFetch());
}, 60_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await close();
});

const newCode = (email: string) => auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });

describe("email code storage", () => {
  it("keeps only a keyed hash of the code, never the code or its plain SHA-256", async () => {
    const code = await newCode("sari@contoh.id");
    expect(code).toMatch(/^\d{6}$/);
    const { rows } = await client.query<{ value: string }>("SELECT value FROM verifications WHERE identifier = 'sign-in-otp-sari@contoh.id'");
    const stored = rows[0]!.value.split(":")[0];
    expect(stored).not.toContain(code);
    expect(stored).not.toBe(createHash("sha256").update(code).digest("base64url"));
  });
});

describe("sessions", () => {
  it("store no IP address or user agent, and accept only the signed token", async () => {
    const signIn = await auth.api.signInEmailOTP({
      body: { email: "dimas@contoh.id", otp: await newCode("dimas@contoh.id") },
      headers: new Headers({ "user-agent": "Peramban Tes", "x-forwarded-for": "198.51.100.9" }),
      returnHeaders: true,
    });
    const signed = signIn.headers.get("set-auth-token")!;
    expect(signed.startsWith(`${signIn.response.token}.`)).toBe(true);

    const { rows } = await client.query("SELECT ip_address, user_agent FROM sessions WHERE token = $1", [signIn.response.token]);
    expect(rows).toEqual([{ ip_address: null, user_agent: null }]);

    const bearer = (token: string) => new Headers({ authorization: `Bearer ${token}` });
    expect((await auth.api.getSession({ headers: bearer(signed) }))?.user.email).toBe("dimas@contoh.id");
    expect(await auth.api.getSession({ headers: bearer(signIn.response.token) })).toBeNull();
  });
});

describe("Google accounts", () => {
  it("link to the account with the same email and keep no Google tokens or photo", async () => {
    const byCode = await auth.api.signInEmailOTP({ body: { email: "rina@contoh.id", otp: await newCode("rina@contoh.id") } });
    const token = googleIdToken({ email: "rina@contoh.id", name: "Rina", picture: "https://contoh.id/foto.jpg", sub: "2001" });
    const byGoogle = await auth.api.signInSocial({ body: { provider: "google", idToken: { token } } });
    expect("user" in byGoogle && byGoogle.user.id).toBe(byCode.user.id);

    const { rows } = await client.query("SELECT provider_id, account_id, id_token, access_token, scope FROM accounts WHERE user_id = $1", [byCode.user.id]);
    expect(rows).toEqual([{ provider_id: "google", account_id: "2001", id_token: null, access_token: null, scope: null }]);
    const user = await client.query("SELECT image FROM users WHERE id = $1", [byCode.user.id]);
    expect(user.rows).toEqual([{ image: null }]);
  });
});
