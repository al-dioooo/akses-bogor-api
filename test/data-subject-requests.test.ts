import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/client.js";
import { auditLog, dataSubjectRequests, users } from "../src/db/schema.js";
import { closeRequest, findAccount, findHandler, listOpenRequests, openRequestFor, parseReceivedAt, recordRequest } from "../src/data-subject/requests.js";
import { createTestDb } from "./helpers/db.js";

let db: Db;
let close: () => Promise<void>;
let userId: string;
let adminId: string;
const now = new Date("2026-11-27T03:00:00.000Z");
const hours = (n: number) => new Date(now.getTime() + n * 3_600_000);

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  userId = (await db.insert(users).values({ displayName: "Warga", email: "warga@contoh.id" }).returning({ id: users.id }))[0]!.id;
  adminId = (await db.insert(users).values({ displayName: "Admin", email: "admin@contoh.id", role: "admin" }).returning({ id: users.id }))[0]!.id;
  await db.insert(users).values({ displayName: "Verifikator", email: "verifikator@contoh.id", role: "verifikator" });
});

afterAll(async () => {
  await close();
});

describe("finding accounts", () => {
  it("finds an account by email in any case or by id", async () => {
    expect(await findAccount(db, " Warga@Contoh.ID ")).toEqual({ id: userId, email: "warga@contoh.id" });
    expect((await findAccount(db, userId.toUpperCase())).id).toBe(userId);
  });

  it("rejects an unknown account", async () => {
    await expect(findAccount(db, "tidak-ada@contoh.id")).rejects.toMatchObject({ code: "akun_tidak_ditemukan" });
    await expect(findAccount(db, crypto.randomUUID())).rejects.toMatchObject({ code: "akun_tidak_ditemukan" });
  });

  it("accepts only an admin as the handler", async () => {
    expect(await findHandler(db, "ADMIN@contoh.id")).toEqual({ id: adminId });
    await expect(findHandler(db, "verifikator@contoh.id")).rejects.toMatchObject({ code: "bukan_admin" });
    await expect(findHandler(db, "tidak-ada@contoh.id")).rejects.toMatchObject({ code: "bukan_admin" });
  });
});

describe("parsing the received time", () => {
  it("reads a time without a zone as WIB and accepts ISO 8601", () => {
    expect(parseReceivedAt("2026-11-27 09:15", now).toISOString()).toBe("2026-11-27T02:15:00.000Z");
    expect(parseReceivedAt("2026-11-26T20:00:00Z", now).toISOString()).toBe("2026-11-26T20:00:00.000Z");
  });

  it("rejects garbage and times in the future", () => {
    expect(() => parseReceivedAt("kemarin", now)).toThrow(expect.objectContaining({ code: "waktu_tidak_sah" }));
    expect(() => parseReceivedAt("2026-11-28 09:15", now)).toThrow(expect.objectContaining({ code: "waktu_di_masa_depan" }));
  });
});

describe("recording requests", () => {
  it("records a request with a 3 × 24 hour deadline and audits it on the account without the email", async () => {
    const { id, dueAt } = await recordRequest(db, { kind: "salinan", userId, receivedAt: hours(-2), handler: { id: adminId }, now });
    expect(dueAt).toEqual(hours(70));
    const [row] = await db.select().from(dataSubjectRequests).where(eq(dataSubjectRequests.id, id));
    expect(row).toMatchObject({ kind: "salinan", userId, handledBy: adminId, completedAt: null, outcome: null });
    const entries = await db.select().from(auditLog).where(eq(auditLog.entityId, userId));
    expect(entries).toEqual([expect.objectContaining({ entityType: "pengguna", actorId: adminId, action: "permintaan_dicatat", changes: { permintaan: id, jenis: "salinan" } })]);
    expect(JSON.stringify(entries)).not.toContain("warga@contoh.id");
  });

  it("records a request from someone without an account", async () => {
    const before = (await db.select().from(auditLog)).length;
    const { id } = await recordRequest(db, { kind: "pertanyaan", userId: null, receivedAt: now, handler: { id: adminId }, now });
    expect((await db.select().from(dataSubjectRequests).where(eq(dataSubjectRequests.id, id)))[0]!.userId).toBeNull();
    expect(await db.select().from(auditLog)).toHaveLength(before);
  });

  it("lists open requests oldest first with their deadlines", async () => {
    const open = await listOpenRequests(db);
    expect(open.map((r) => r.kind)).toEqual(["salinan", "pertanyaan"]);
    expect(open[0]!.dueAt).toEqual(hours(70));
  });
});

describe("closing requests", () => {
  it("requires a reason to refuse", async () => {
    const { id } = await recordRequest(db, { kind: "perbaikan", userId, receivedAt: now, handler: { id: adminId }, now });
    await expect(closeRequest(db, id, { outcome: "ditolak", note: " ", handler: { id: adminId }, now })).rejects.toMatchObject({ code: "alasan_wajib" });
    expect(await closeRequest(db, id, { outcome: "ditolak", note: "Akan mengungkap data pribadi orang lain", handler: { id: adminId }, now })).toEqual({ kind: "perbaikan", late: false });
    const [row] = await db.select().from(dataSubjectRequests).where(eq(dataSubjectRequests.id, id));
    expect(row).toMatchObject({ outcome: "ditolak", note: "Akan mengungkap data pribadi orang lain", completedAt: now });
  });

  it("marks a request done, says when it is late, and refuses to close it twice", async () => {
    const { id } = await recordRequest(db, { kind: "pembatasan", userId, receivedAt: hours(-80), handler: { id: adminId }, now });
    expect(await closeRequest(db, id, { outcome: "selesai", note: null, handler: { id: adminId }, now })).toEqual({ kind: "pembatasan", late: true });
    await expect(closeRequest(db, id, { outcome: "selesai", note: null, handler: { id: adminId }, now })).rejects.toMatchObject({ code: "permintaan_sudah_ditutup" });
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "permintaan_selesai"));
    expect(entry).toMatchObject({ entityId: userId, actorId: adminId, changes: { permintaan: id } });
    expect((await listOpenRequests(db)).map((r) => r.id)).not.toContain(id);
  });

  it("rejects closing a request that does not exist", async () => {
    await expect(closeRequest(db, 9999, { outcome: "selesai", note: null, handler: { id: adminId }, now })).rejects.toMatchObject({ code: "permintaan_tidak_ditemukan" });
  });
});

describe("using a request from another script", () => {
  it("accepts an open request for the same account and a matching kind", async () => {
    const { id } = await recordRequest(db, { kind: "salinan", userId, receivedAt: now, handler: { id: adminId }, now });
    expect(await openRequestFor(db, id, userId, ["salinan"])).toMatchObject({ id, kind: "salinan" });
  });

  it("rejects a request for another account, of another kind, or already closed", async () => {
    const { id } = await recordRequest(db, { kind: "salinan", userId, receivedAt: now, handler: { id: adminId }, now });
    await expect(openRequestFor(db, id, adminId, ["salinan"])).rejects.toMatchObject({ code: "permintaan_akun_lain" });
    await expect(openRequestFor(db, id, userId, ["pembatasan"])).rejects.toMatchObject({ code: "jenis_permintaan_tidak_cocok" });
    await closeRequest(db, id, { outcome: "selesai", note: null, handler: { id: adminId }, now });
    await expect(openRequestFor(db, id, userId, ["salinan"])).rejects.toMatchObject({ code: "permintaan_sudah_ditutup" });
    await expect(openRequestFor(db, 9999, userId, ["salinan"])).rejects.toMatchObject({ code: "permintaan_tidak_ditemukan" });
  });
});
