import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { setReportEmails } from "../src/data-subject/report-emails.js";
import { auditLog, reportEmails, users } from "../src/db/schema.js";
import { sendReportEmails } from "../src/verification/emails.js";
import { verificationRig, type Rig } from "./helpers/verification.js";

let rig: Rig;
let reporter: { token: string; user: { id: string } };
let other: { token: string; user: { id: string } };
let verifier: { token: string; user: { id: string } };
let admin: { token: string; user: { id: string } };

const post = (url: string, payload: object) => rig.app.inject({ method: "POST", url, headers: rig.as(verifier.token), payload });
const toggle = (enabled: boolean, userId = reporter.user.id) => setReportEmails(rig.db, { userId, enabled, requestId: 5, handler: { id: admin.user.id }, now: rig.clock.now });
const sentTo = (address: string) => rig.sent.filter((e) => e.to === address && !e.subject.startsWith("Kode masuk")).length;

beforeAll(async () => {
  rig = await verificationRig();
  reporter = await rig.helpers.reporter("pelapor@contoh.id", "Warga Bogor");
  other = await rig.helpers.reporter("lain@contoh.id", "Warga Lain");
  verifier = await rig.verifier("verifikator@contoh.id");
  admin = await rig.verifier("admin@contoh.id", "Admin", "admin");
}, 120_000);

afterAll(async () => {
  await rig.close();
});

describe("turning report status emails off", () => {
  it("drops the account's queued emails and leaves other accounts alone", async () => {
    const asking = await rig.submit(reporter.token, rig.newPlace());
    const otherAsking = await rig.submit(other.token, rig.newPlace({ name: "Halte lain contoh" }));
    rig.mail.failing = true;
    await post(`/verifier/reports/${asking}/clarify`, { question: "Pintu mana yang dipakai?" });
    await post(`/verifier/reports/${otherAsking}/clarify`, { question: "Ada foto lain?" });
    rig.mail.failing = false;
    expect(await rig.db.select().from(reportEmails)).toHaveLength(2);

    expect(await toggle(false)).toEqual({ changed: true, dropped: 1 });
    expect((await rig.db.select({ reportId: reportEmails.reportId }).from(reportEmails)).map((r) => r.reportId)).toEqual([otherAsking]);
    const [user] = await rig.db.select({ offAt: users.reportEmailsOffAt }).from(users).where(eq(users.id, reporter.user.id));
    expect(user!.offAt).toEqual(rig.clock.now);
  });

  it("does not send later status emails to the account", async () => {
    const rejected = await rig.submit(reporter.token, rig.newPlace({ name: "Kampus tolak contoh" }));
    expect((await post(`/verifier/reports/${rejected}/reject`, { reason: "duplikat" })).statusCode).toBe(200);
    // Email lain yang gagal tadi dicoba lagi satu jam kemudian.
    rig.clock.now = new Date(rig.clock.now.getTime() + 2 * 60 * 60 * 1000);
    expect(await sendReportEmails(rig.db, { mailer: async (e) => void rig.sent.push(e), webUrl: "https://akses-bogor.contoh.id" }, rig.clock.now)).toMatchObject({ sent: 1 });
    expect(sentTo("pelapor@contoh.id")).toBe(0);
    expect(sentTo("lain@contoh.id")).toBe(1);
    expect(await rig.db.select().from(reportEmails)).toEqual([]);
  });

  it("changes nothing when emails are already off", async () => {
    expect(await toggle(false)).toEqual({ changed: false, dropped: 0 });
  });
});

describe("turning report status emails back on", () => {
  it("sends the next status email again", async () => {
    expect(await toggle(true)).toEqual({ changed: true, dropped: 0 });
    expect(await toggle(true)).toEqual({ changed: false, dropped: 0 });
    const rejected = await rig.submit(reporter.token, rig.newPlace({ name: "Rumah sakit tolak contoh", category: "rumah_sakit" }));
    await post(`/verifier/reports/${rejected}/reject`, { reason: "duplikat" });
    expect(sentTo("pelapor@contoh.id")).toBe(1);
  });

  it("records both changes in the audit log with the request number", async () => {
    const entries = await rig.db.select({ action: auditLog.action, actorId: auditLog.actorId, changes: auditLog.changes }).from(auditLog).where(eq(auditLog.entityId, reporter.user.id));
    expect(entries.filter((e) => e.action.startsWith("email_laporan"))).toEqual([
      { action: "email_laporan_dimatikan", actorId: admin.user.id, changes: { permintaan: 5, antreanDibuang: 1 } },
      { action: "email_laporan_dinyalakan", actorId: admin.user.id, changes: { permintaan: 5 } },
    ]);
  });

  it("rejects an account that does not exist", async () => {
    await expect(toggle(false, crypto.randomUUID())).rejects.toMatchObject({ code: "akun_tidak_ditemukan" });
  });
});
