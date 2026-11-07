import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import type { Email, Mailer } from "../src/email/mailer.js";
import { createTestDb } from "./helpers/db.js";
import { googleCertsFetch, googleIdToken } from "./helpers/google.js";

const base = { NODE_ENV: "test", DATABASE_URL: "postgresql://test@localhost/test" };
const accountEnv = { ...base, BETTER_AUTH_SECRET: "rahasia-tes-yang-panjangnya-lebih-dari-32-karakter", GOOGLE_CLIENT_ID: "client-tes" };

let app: Awaited<ReturnType<typeof buildApp>>;
let client: PGlite;
let close: () => Promise<void>;
const sent: Email[] = [];
let failNextEmail = false;
const mailer: Mailer = async (email) => {
  if (failNextEmail) {
    failNextEmail = false;
    throw new Error("Resend menjawab 500");
  }
  sent.push(email);
};

beforeAll(async () => {
  const test = await createTestDb();
  client = test.client;
  close = test.close;
  vi.stubGlobal("fetch", googleCertsFetch());
  app = await buildApp(loadEnv(accountEnv), { db: test.db, mailer });
  await app.ready();
}, 60_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
  await close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Setiap tes memakai IP sendiri supaya batas per klien tidak saling memengaruhi.
let ipCounter = 10;
const nextIp = () => `203.0.113.${ipCounter++}`;

const post = (url: string, payload: object, ip = nextIp(), headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, payload, remoteAddress: ip, headers });
const requestCode = (email: string, ip?: string) => post("/auth/code", { email }, ip);
const lastCode = () => sent.at(-1)!.subject.slice(-6);
const verify = (email: string, code: string, ip?: string) => post("/auth/code/verify", { email, code }, ip);
const me = (token?: string) => app.inject({ method: "GET", url: "/me", headers: token ? { authorization: `Bearer ${token}` } : {} });

async function signIn(email: string) {
  await requestCode(email);
  const res = await verify(email, lastCode());
  return res.json() as { token: string; expiresAt: string; user: { id: string; displayName: string; needsCompletion: boolean } };
}

describe("POST /auth/code", () => {
  it("sends a 6-digit code to the lower-cased address", async () => {
    const res = await requestCode("  Sari@Contoh.ID ");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ resendAfterSeconds: 60, expiresInSeconds: 600 });
    expect(sent.at(-1)!.to).toBe("sari@contoh.id");
    expect(lastCode()).toMatch(/^\d{6}$/);
  });

  it("asks to wait 60 seconds before another code for the same address", async () => {
    await requestCode("jeda@contoh.id");
    const res = await requestCode("JEDA@contoh.id");
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ galat: "kode_terlalu_sering", pesan: expect.stringMatching(/Tunggu \d+ detik/) });
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("allows at most five codes per address per hour", async () => {
    const start = Date.now();
    const clock = vi.spyOn(Date, "now");
    for (let i = 0; i < 5; i++) {
      clock.mockReturnValue(start + i * 61_000);
      expect((await requestCode("sejam@contoh.id")).statusCode).toBe(200);
    }
    clock.mockReturnValue(start + 5 * 61_000);
    const res = await requestCode("sejam@contoh.id");
    expect(res.statusCode).toBe(429);
    expect(res.json().pesan).toMatch(/Sudah 5 kode/);
  });

  it("allows ten code requests per client per 15 minutes", async () => {
    const ip = nextIp();
    for (let i = 0; i < 10; i++) expect((await requestCode(`klien${i}@contoh.id`, ip)).statusCode).toBe(200);
    const res = await requestCode("klien10@contoh.id", ip);
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ galat: "terlalu_sering", pesan: expect.stringMatching(/permintaan kode.*15 menit/) });
  });

  it("rejects an address that is not an email", async () => {
    const res = await requestCode("bukan-email");
    expect(res.statusCode).toBe(400);
    expect(res.json().galat).toBe("input_tidak_valid");
  });

  it("answers 502 when the email cannot be sent", async () => {
    failNextEmail = true;
    const res = await requestCode("gagal@contoh.id");
    expect(res.statusCode).toBe(502);
    expect(res.json().galat).toBe("email_gagal_dikirim");
  });
});

describe("POST /auth/code/verify", () => {
  it("signs in with the right code and creates an account that still needs completing", async () => {
    await requestCode("baru@contoh.id");
    const res = await verify("baru@contoh.id", lastCode());
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toMatch(/^[\w-]+\.[\w+/=-]+$/);
    expect(new Date(body.expiresAt).getTime() - Date.now()).toBeGreaterThan(89 * 24 * 60 * 60 * 1000);
    expect(body.user).toMatchObject({ email: "baru@contoh.id", displayName: "", role: "pengguna", needsCompletion: true });
  });

  it("counts down the attempts on a wrong code, then voids the code on the fifth", async () => {
    await requestCode("salah@contoh.id");
    const right = lastCode();
    const wrong = right === "000000" ? "111111" : "000000";
    const ip = nextIp();
    for (const remaining of [4, 3, 2, 1]) {
      const res = await verify("salah@contoh.id", wrong, ip);
      expect(res.json()).toEqual({ galat: "kode_salah", pesan: `Kode salah. Sisa ${remaining} kali percobaan.` });
    }
    expect((await verify("salah@contoh.id", wrong, ip)).json().galat).toBe("kode_terkunci");
    expect((await verify("salah@contoh.id", right, ip)).json().galat).toBe("kode_tidak_berlaku");
  });

  it("refuses an expired code", async () => {
    await requestCode("lama@contoh.id");
    await client.query("UPDATE verifications SET expires_at = now() - interval '1 second' WHERE identifier = 'sign-in-otp-lama@contoh.id'");
    const res = await verify("lama@contoh.id", lastCode());
    expect(res.statusCode).toBe(400);
    expect(res.json().galat).toBe("kode_kedaluwarsa");
  });

  it("refuses a code that was already used", async () => {
    await requestCode("sekali@contoh.id");
    const code = lastCode();
    expect((await verify("sekali@contoh.id", code)).statusCode).toBe(200);
    expect((await verify("sekali@contoh.id", code)).json().galat).toBe("kode_tidak_berlaku");
  });

  it("rejects a code that is not six digits", async () => {
    expect((await verify("sari@contoh.id", "12345")).json().galat).toBe("input_tidak_valid");
  });

  it("allows 30 attempts per client per 15 minutes", async () => {
    const ip = nextIp();
    for (let i = 0; i < 30; i++) await verify("sari@contoh.id", "1", ip);
    const res = await verify("sari@contoh.id", "1", ip);
    expect(res.statusCode).toBe(429);
    expect(res.json().pesan).toMatch(/percobaan kode/);
  });
});

describe("POST /auth/google", () => {
  const google = (claims: Record<string, unknown>) => post("/auth/google", { idToken: googleIdToken(claims) });

  it("signs in with a verified Google email and suggests the Google name", async () => {
    const res = await google({ email: "Budi@Gmail.com", name: "Budi Santoso", sub: "3001" });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ email: "budi@gmail.com", displayName: "Budi Santoso", needsCompletion: true });
  });

  it("uses the same account as the email code for the same address", async () => {
    const byCode = await signIn("sama@contoh.id");
    const res = await google({ email: "sama@contoh.id", name: "Sama", sub: "3002" });
    expect(res.json().user.id).toBe(byCode.user.id);
  });

  it("refuses an email Google has not verified", async () => {
    const res = await google({ email: "belum@contoh.id", email_verified: false, sub: "3003" });
    expect(res.statusCode).toBe(403);
    expect(res.json().galat).toBe("email_google_belum_terverifikasi");
  });

  it("refuses a token for another client ID", async () => {
    const res = await google({ email: "lain@contoh.id", aud: "client-lain", sub: "3004" });
    expect(res.statusCode).toBe(401);
    expect(res.json().galat).toBe("google_tidak_valid");
  });

  it("refuses an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 7200;
    const res = await google({ email: "kedaluwarsa@contoh.id", iat: past, exp: past + 600, sub: "3005" });
    expect(res.json().galat).toBe("google_tidak_valid");
  });
});

describe("sessions", () => {
  it("GET /me answers the signed-in account and 401 without a valid token", async () => {
    const { token, user } = await signIn("sesi@contoh.id");
    const res = await me(token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: user.id, email: "sesi@contoh.id", needsCompletion: true });
    expect(res.headers["cache-control"]).toBe("no-store");

    expect((await me()).json()).toEqual({ galat: "belum_masuk", pesan: expect.any(String) });
    expect((await me(token.split(".")[0])).statusCode).toBe(401);
  });

  it("logging out revokes the session and can be repeated", async () => {
    const { token } = await signIn("keluar@contoh.id");
    const logout = () => post("/auth/logout", {}, undefined, { authorization: `Bearer ${token}` });
    expect((await logout()).statusCode).toBe(204);
    expect((await me(token)).statusCode).toBe(401);
    expect((await logout()).statusCode).toBe(204);
  });

  it("ends a session 90 days after signing in even if it was used daily", async () => {
    const { token, user } = await signIn("lama-sesi@contoh.id");
    await client.query("UPDATE sessions SET created_at = now() - interval '91 days' WHERE user_id = $1", [user.id]);
    expect((await me(token)).statusCode).toBe(401);
    const { rows } = await client.query("SELECT count(*)::int AS count FROM sessions WHERE user_id = $1", [user.id]);
    expect(rows).toEqual([{ count: 0 }]);
  });
});

describe("account features that are not configured", () => {
  it("answer 503 without a session secret in production, and without email or Google settings", async () => {
    const test = await createTestDb();
    const production = await buildApp(loadEnv({ ...base, NODE_ENV: "production" }), { db: test.db });
    const noEmail = await buildApp(loadEnv({ ...base, NODE_ENV: "production", BETTER_AUTH_SECRET: accountEnv.BETTER_AUTH_SECRET }), { db: test.db });
    try {
      expect((await production.inject({ method: "POST", url: "/auth/code", payload: { email: "a@contoh.id" } })).json().galat).toBe("akun_belum_diatur");
      expect((await production.inject({ method: "GET", url: "/me" })).json().galat).toBe("akun_belum_diatur");
      expect((await noEmail.inject({ method: "POST", url: "/auth/code", payload: { email: "a@contoh.id" } })).json().galat).toBe("email_belum_diatur");
      const googleRes = await noEmail.inject({ method: "POST", url: "/auth/google", payload: { idToken: googleIdToken({ email: "a@contoh.id" }) } });
      expect(googleRes.json().galat).toBe("google_belum_diatur");
    } finally {
      await Promise.all([production.close(), noEmail.close()]);
      await test.close();
    }
  }, 60_000);
});
