import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { holdReports, releaseReports } from "../src/data-subject/hold.js";
import { auditLog, reportClarifications, reports } from "../src/db/schema.js";
import { expireClarifications } from "../src/verification/jobs.js";
import { facilities, verificationRig, type Rig } from "./helpers/verification.js";

let rig: Rig;
let reporter: { token: string; user: { id: string } };
let verifier: { token: string; user: { id: string } };
let admin: { token: string; user: { id: string } };
let waiting: string;
let asking: string;
let rejected: string;
let photo: string;
const DAY_MS = 24 * 60 * 60 * 1000;
const start = new Date("2026-11-08T03:00:00.000Z");
const at = (days: number) => new Date(start.getTime() + days * DAY_MS);

const post = (url: string, payload: object, token = verifier.token) => rig.app.inject({ method: "POST", url, headers: rig.as(token), payload });
const get = (url: string, token = verifier.token) => rig.app.inject({ method: "GET", url, headers: rig.as(token) });
const queue = async (status: string) => ((await get(`/verifier/reports?status=${status}`)).json() as { items: { id: string }[] }).items.map((r) => r.id);
const input = () => ({ userId: reporter.user.id, requestId: 3, handler: { id: admin.user.id }, now: rig.clock.now });
const checked = () => facilities({ ramp: { answer: "tersedia" } }).map((f) => ({ reason: null, note: null, evidence: "terbukti", ...f }));

beforeAll(async () => {
  rig = await verificationRig(start);
  reporter = await rig.helpers.reporter("pelapor@contoh.id", "Warga Bogor");
  verifier = await rig.verifier("verifikator@contoh.id");
  admin = await rig.verifier("admin@contoh.id", "Admin", "admin");

  photo = await rig.uploadPhoto(reporter.token);
  waiting = await rig.submit(reporter.token, { ...rig.newPlace(), photos: [{ id: photo, tag: "pintu_masuk" }] });
  asking = await rig.submit(reporter.token, rig.newPlace({ name: "Halte tanya contoh" }));
  await post(`/verifier/reports/${asking}/clarify`, { question: "Pintu mana yang dipakai?" });
  rejected = await rig.submit(reporter.token, rig.newPlace({ name: "Kampus tolak contoh" }));
  await post(`/verifier/reports/${rejected}/reject`, { reason: "duplikat" });
}, 120_000);

afterAll(async () => {
  await rig.close();
});

describe("holding reports", () => {
  it("requires a reason", async () => {
    await expect(holdReports(rig.db, { ...input(), reason: "  " })).rejects.toMatchObject({ code: "alasan_wajib" });
  });

  it("holds only the reports that are not decided yet", async () => {
    rig.clock.now = at(1);
    expect(await holdReports(rig.db, { ...input(), reason: "Pelapor meminta penundaan, permintaan #3" })).toEqual({ held: 2 });
    const rows = await rig.db.select({ id: reports.id, heldAt: reports.heldAt, holdReason: reports.holdReason }).from(reports).where(inArray(reports.id, [waiting, asking, rejected]));
    expect(rows.filter((r) => r.heldAt).map((r) => r.id).sort()).toEqual([waiting, asking].sort());
    expect(rows.find((r) => r.id === rejected)).toMatchObject({ heldAt: null, holdReason: null });
    expect(await holdReports(rig.db, { ...input(), reason: "lagi" })).toEqual({ held: 0 });
  });

  it("keeps held reports out of the queue and away from verifiers", async () => {
    expect(await queue("menunggu")).not.toContain(waiting);
    expect(await queue("klarifikasi")).not.toContain(asking);
    for (const res of [
      await get(`/verifier/reports/${waiting}`),
      await get(`/verifier/photos/${photo}`),
      await post(`/verifier/reports/${waiting}/reject`, { reason: "duplikat" }),
      await post(`/verifier/reports/${waiting}/clarify`, { question: "Ada foto lain?" }),
      await post(`/verifier/reports/${waiting}/publish`, { name: "Masjid Al-Ikhlas contoh", category: "masjid", location: { lat: -6.5976, lng: 106.7991 }, description: null, facilities: checked() }),
      await rig.app.inject({ method: "PATCH", url: `/verifier/reports/${waiting}/photos/${photo}`, headers: rig.as(verifier.token), payload: { hidden: true } }),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ galat: "laporan_ditahan" });
    }
    const [report] = await rig.db.select({ status: reports.status }).from(reports).where(eq(reports.id, waiting));
    expect(report!.status).toBe("menunggu");
  });

  it("does not reject a held report when its clarification deadline passes", async () => {
    rig.clock.now = at(10);
    expect(await expireClarifications(rig.db, undefined, rig.clock.now)).toBe(0);
    const [report] = await rig.db.select({ status: reports.status }).from(reports).where(eq(reports.id, asking));
    expect(report!.status).toBe("klarifikasi");
  });

  it("records each hold in the audit log without the reason", async () => {
    const entries = await rig.db.select().from(auditLog).where(eq(auditLog.action, "laporan_ditahan"));
    expect(entries.map((e) => e.entityId).sort()).toEqual([waiting, asking].sort());
    expect(entries.every((e) => e.actorId === admin.user.id && JSON.stringify(e.changes) === JSON.stringify({ permintaan: 3 }))).toBe(true);
  });
});

describe("releasing reports", () => {
  it("returns them to the queue and extends the clarification deadline by the time held", async () => {
    const [before] = await rig.db.select({ dueAt: reports.clarificationDueAt }).from(reports).where(eq(reports.id, asking));
    expect(await releaseReports(rig.db, input())).toEqual({ released: 2 });
    expect(await queue("menunggu")).toContain(waiting);
    expect(await queue("klarifikasi")).toContain(asking);

    const [after] = await rig.db.select({ dueAt: reports.clarificationDueAt, heldAt: reports.heldAt, holdReason: reports.holdReason }).from(reports).where(eq(reports.id, asking));
    expect(after).toMatchObject({ heldAt: null, holdReason: null });
    expect(after!.dueAt!.getTime() - before!.dueAt!.getTime()).toBe(9 * DAY_MS);
    const [question] = await rig.db.select({ dueAt: reportClarifications.dueAt }).from(reportClarifications).where(eq(reportClarifications.reportId, asking));
    expect(question!.dueAt).toEqual(after!.dueAt);
    expect(await expireClarifications(rig.db, undefined, rig.clock.now)).toBe(0);
  });

  it("records the release and does nothing when nothing is held", async () => {
    expect(await rig.db.select().from(auditLog).where(eq(auditLog.action, "laporan_dilepas"))).toHaveLength(2);
    expect(await releaseReports(rig.db, input())).toEqual({ released: 0 });
  });
});
