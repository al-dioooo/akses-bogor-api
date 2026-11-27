import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { deleteAccountOnRequest } from "../src/data-subject/delete.js";
import { closeRequest, recordRequest } from "../src/data-subject/requests.js";
import { auditLog, dataSubjectRequests, photoDeletions, reports, sessions, users } from "../src/db/schema.js";
import { verificationRig, type Rig } from "./helpers/verification.js";

let rig: Rig;
let reporter: { token: string; user: { id: string } };
let admin: { token: string; user: { id: string } };
let requestId: number;
let report: string;
let photo: string;

const remove = (userId: string) => deleteAccountOnRequest(rig.db, { userId, requestId, handler: { id: admin.user.id }, now: rig.clock.now });

beforeAll(async () => {
  rig = await verificationRig();
  reporter = await rig.helpers.reporter("pelapor@contoh.id", "Warga Bogor");
  admin = await rig.verifier("admin@contoh.id", "Admin", "admin");
  photo = await rig.uploadPhoto(reporter.token);
  report = await rig.submit(reporter.token, { ...rig.newPlace(), photos: [{ id: photo, tag: "pintu_masuk" }] });
  ({ id: requestId } = await recordRequest(rig.db, { kind: "penghapusan", userId: reporter.user.id, receivedAt: rig.clock.now, handler: { id: admin.user.id }, now: rig.clock.now }));
}, 120_000);

afterAll(async () => {
  await rig.close();
});

describe("deleting an account on request", () => {
  it("refuses to delete an admin account", async () => {
    await expect(remove(admin.user.id)).rejects.toMatchObject({ code: "akun_admin" });
    expect(await rig.db.select().from(users).where(eq(users.id, admin.user.id))).toHaveLength(1);
  });

  it("deletes the account like Hapus akun and queues its photo files", async () => {
    await remove(reporter.user.id);
    expect(await rig.db.select().from(users).where(eq(users.id, reporter.user.id))).toEqual([]);
    expect(await rig.db.select().from(sessions).where(eq(sessions.userId, reporter.user.id))).toEqual([]);
    expect(await rig.db.select().from(reports).where(eq(reports.id, report))).toEqual([]);
    expect((await rig.db.select().from(photoDeletions)).map((d) => d.storageKey)).toContain(`laporan/${photo}.webp`);
    expect((await rig.app.inject({ method: "GET", url: "/me", headers: rig.as(reporter.token) })).statusCode).toBe(401);
  });

  it("keeps the request and an audit entry with the request number, without the email", async () => {
    const [entry] = await rig.db.select().from(auditLog).where(eq(auditLog.action, "akun_dihapus"));
    expect(entry).toMatchObject({ entityType: "pengguna", entityId: reporter.user.id, actorId: admin.user.id, changes: { permintaan: requestId } });
    expect(JSON.stringify(await rig.db.select().from(auditLog))).not.toContain("pelapor@contoh.id");
    expect(await closeRequest(rig.db, requestId, { outcome: "selesai", note: null, handler: { id: admin.user.id }, now: rig.clock.now })).toMatchObject({ kind: "penghapusan" });
    const [request] = await rig.db.select().from(dataSubjectRequests).where(eq(dataSubjectRequests.id, requestId));
    expect(request).toMatchObject({ userId: reporter.user.id, outcome: "selesai" });
  });

  it("rejects an account that no longer exists", async () => {
    await expect(remove(reporter.user.id)).rejects.toMatchObject({ code: "akun_tidak_ditemukan" });
  });
});
