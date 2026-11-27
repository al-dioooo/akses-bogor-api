import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { changeEmail, normalizeEmail } from "../src/data-subject/change-email.js";
import { findAccount } from "../src/data-subject/requests.js";
import { accounts, auditLog, sessions, users, verifications } from "../src/db/schema.js";
import { verificationRig, type Rig } from "./helpers/verification.js";

let rig: Rig;
let owner: { token: string; user: { id: string } };
let other: { token: string; user: { id: string } };
let admin: { token: string; user: { id: string } };

const me = (token: string) => rig.app.inject({ method: "GET", url: "/me", headers: rig.as(token) });
const change = (newEmail: string, userId = owner.user.id) => changeEmail(rig.db, { userId, newEmail, requestId: 7, handler: { id: admin.user.id }, now: rig.clock.now });

beforeAll(async () => {
  rig = await verificationRig();
  owner = await rig.helpers.reporter("lama@contoh.id", "Pemilik");
  other = await rig.helpers.reporter("dipakai@contoh.id", "Orang Lain");
  admin = await rig.verifier("admin@contoh.id", "Admin", "admin");
  await rig.db.insert(accounts).values({ userId: owner.user.id, providerId: "google", accountId: "108234567890" });
  // Kode yang belum dipakai untuk email lama dan baru.
  const expiresAt = new Date(rig.clock.now.getTime() + 600_000);
  await rig.db.insert(verifications).values([
    { identifier: "sign-in-otp-lama@contoh.id", value: "hash:0", expiresAt },
    { identifier: "sign-in-otp-baru@contoh.id", value: "hash:0", expiresAt },
  ]);
}, 120_000);

afterAll(async () => {
  await rig.close();
});

describe("normalizing the new email", () => {
  it("lowercases and trims, and rejects what is not an email", () => {
    expect(normalizeEmail("  Baru@Contoh.ID ")).toBe("baru@contoh.id");
    expect(() => normalizeEmail("bukan email")).toThrow(expect.objectContaining({ code: "email_tidak_sah" }));
  });
});

describe("changing an account email", () => {
  it("rejects an email that another account uses, in any case, or the same email", async () => {
    await expect(change("Dipakai@Contoh.id")).rejects.toMatchObject({ code: "email_sudah_dipakai" });
    await expect(change("LAMA@contoh.id")).rejects.toMatchObject({ code: "email_sama" });
    expect((await me(owner.token)).statusCode).toBe(200);
  });

  it("changes the email, ends every session, unlinks Google, and drops unused codes", async () => {
    expect(await change(" Baru@Contoh.ID")).toEqual({ sessions: 1, links: 1 });
    const [user] = await rig.db.select({ email: users.email, emailVerified: users.emailVerified }).from(users).where(eq(users.id, owner.user.id));
    expect(user).toEqual({ email: "baru@contoh.id", emailVerified: false });
    expect(await rig.db.select().from(sessions).where(eq(sessions.userId, owner.user.id))).toEqual([]);
    expect(await rig.db.select().from(accounts).where(eq(accounts.userId, owner.user.id))).toEqual([]);
    expect(await rig.db.select().from(verifications).where(inArray(verifications.identifier, ["sign-in-otp-lama@contoh.id", "sign-in-otp-baru@contoh.id"]))).toEqual([]);
    expect((await me(owner.token)).statusCode).toBe(401);
    expect((await me(other.token)).statusCode).toBe(200);
  });

  it("records the change in the audit log without either email", async () => {
    const entries = await rig.db.select().from(auditLog).where(eq(auditLog.action, "email_diubah"));
    expect(entries).toEqual([expect.objectContaining({ entityId: owner.user.id, actorId: admin.user.id, changes: { permintaan: 7, sesiDiakhiri: 1, tautanDilepas: 1 } })]);
    expect(JSON.stringify(entries)).not.toMatch(/lama@|baru@/);
  });

  it("lets the owner sign in to the same account with a code sent to the new email", async () => {
    const session = await rig.helpers.signIn("baru@contoh.id");
    expect(session.user.id).toBe(owner.user.id);
    expect((await me(session.token)).json()).toMatchObject({ email: "baru@contoh.id", displayName: "Pemilik", needsCompletion: false });
    const [user] = await rig.db.select({ emailVerified: users.emailVerified }).from(users).where(eq(users.id, owner.user.id));
    expect(user!.emailVerified).toBe(true);
  });

  it("no longer finds the account by its old email", async () => {
    await expect(findAccount(rig.db, "lama@contoh.id")).rejects.toMatchObject({ code: "akun_tidak_ditemukan" });
  });

  it("rejects an account that does not exist", async () => {
    await expect(change("siapa@contoh.id", crypto.randomUUID())).rejects.toMatchObject({ code: "akun_tidak_ditemukan" });
  });
});
