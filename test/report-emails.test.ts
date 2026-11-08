import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { reportEmails } from "../src/db/schema.js";
import { clarificationEmail, REJECTION, reportPublishedEmail, reportRejectedEmail } from "../src/email/report-status.js";
import { sendReportEmails } from "../src/verification/emails.js";
import { verificationRig, type Rig } from "./helpers/verification.js";

const HOUR = 3600_000;
const WEB = "https://akses-bogor.contoh.id";

describe("report status emails (FR-40, FR-41)", () => {
  it("link to the place, the account page, or the answer page, without tracking or images", () => {
    const published = reportPublishedEmail("sari@contoh.id", { placeName: "Halte contoh", placeId: "p1", webUrl: `${WEB}/` });
    expect(published.subject).toBe("Laporan Anda sudah terbit: Halte contoh");
    expect(published.text).toContain(`${WEB}/lokasi/p1`);
    const rejected = reportRejectedEmail("sari@contoh.id", { placeName: "Halte contoh", reason: "di_luar_kota_bogor", webUrl: WEB });
    expect(rejected.text).toContain(`Alasan: Di luar Kota Bogor. ${REJECTION.di_luar_kota_bogor.message}`);
    const asked = clarificationEmail("sari@contoh.id", { placeName: "Halte <contoh>", reportId: "r1", question: "Ada foto lift?", dueAt: new Date("2026-11-15T03:00:00Z"), webUrl: WEB });
    expect(asked.text).toContain("Ada foto lift?");
    expect(asked.text).toContain(`Jawab paling lambat 15 November 2026 pukul 10.00 WIB di ${WEB}/akun/laporan/r1.`);
    expect(asked.html).toContain("Halte &lt;contoh&gt;");
    for (const message of [published, rejected, asked]) expect(message.html).not.toMatch(/<img|<a /);
  });
});

describe("sendReportEmails (ADR-0039)", () => {
  let rig: Rig;
  let reporter: { token: string; user: { id: string } };
  let verifier: { token: string; user: { id: string } };

  beforeAll(async () => {
    rig = await verificationRig();
    reporter = await rig.helpers.reporter("pelapor@contoh.id", "Warga Bogor");
    verifier = await rig.verifier("verifikator@contoh.id");
  }, 90_000);

  afterAll(async () => {
    await rig.close();
  });

  const reject = (id: string) =>
    rig.app.inject({ method: "POST", url: `/verifier/reports/${id}/reject`, headers: rig.as(verifier.token), payload: { reason: "duplikat" } });
  const queued = async (id: string) => rig.db.select().from(reportEmails).where(eq(reportEmails.reportId, id));
  const subjects = () => rig.sent.map((e) => e.subject).filter((s) => !s.startsWith("Kode masuk"));

  it("keeps a failed email and retries it an hour later, without failing the decision", async () => {
    const id = await rig.submit(reporter.token, rig.newPlace({ name: "Masjid gagal kirim contoh" }));
    rig.mail.failing = true;
    expect((await reject(id)).statusCode).toBe(200);
    rig.mail.failing = false;
    expect(await queued(id)).toEqual([expect.objectContaining({ kind: "ditolak", attempts: 1, nextAttemptAt: new Date(rig.clock.now.getTime() + HOUR) })]);

    expect(await sendReportEmails(rig.db, { mailer: async (e) => void rig.sent.push(e), webUrl: WEB }, new Date(rig.clock.now.getTime() + 30 * 60_000))).toEqual({ sent: 0, dropped: 0, failed: 0 });
    const result = await sendReportEmails(rig.db, { mailer: async (e) => void rig.sent.push(e), webUrl: WEB }, new Date(rig.clock.now.getTime() + HOUR));
    expect(result).toEqual({ sent: 1, dropped: 0, failed: 0 });
    expect(subjects().at(-1)).toBe("Laporan Anda belum bisa diterbitkan: Masjid gagal kirim contoh");
    expect(await queued(id)).toEqual([]);
  });

  it("gives up after three days, also when no mailer is configured", async () => {
    const id = await rig.submit(reporter.token, rig.newPlace({ name: "Halte tanpa email contoh" }));
    rig.mail.failing = true;
    await reject(id);
    rig.mail.failing = false;
    const later = new Date(rig.clock.now.getTime() + 2 * 24 * HOUR);
    expect((await sendReportEmails(rig.db, { webUrl: WEB }, later)).failed).toBe(1);
    expect(await queued(id)).toHaveLength(1);
    const expired = new Date(rig.clock.now.getTime() + 3 * 24 * HOUR);
    expect((await sendReportEmails(rig.db, { webUrl: WEB }, expired)).failed).toBe(1);
    expect(await queued(id)).toEqual([]);
  });

  it("drops emails whose reporter deleted the account or whose report changed", async () => {
    const asked = await rig.submit(reporter.token, rig.newPlace({ name: "Kampus ditanya contoh" }));
    rig.mail.failing = true;
    await rig.app.inject({ method: "POST", url: `/verifier/reports/${asked}/clarify`, headers: rig.as(verifier.token), payload: { question: "Ada foto?" } });
    rig.mail.failing = false;
    await reject(asked);
    const before = subjects().length;
    // Pertanyaan yang tertunda tidak dikirim lagi setelah laporannya ditolak.
    expect(await sendReportEmails(rig.db, { mailer: async (e) => void rig.sent.push(e), webUrl: WEB }, new Date(rig.clock.now.getTime() + HOUR))).toMatchObject({ dropped: 1 });
    expect(subjects().slice(before)).toEqual([]);

    const leaving = await rig.helpers.reporter("pergi@contoh.id");
    const id = await rig.submit(leaving.token, rig.newPlace({ name: "Masjid ditinggal contoh" }));
    await rig.db.insert(reportEmails).values({ reportId: id, kind: "ditolak", createdAt: rig.clock.now, nextAttemptAt: rig.clock.now });
    expect((await rig.app.inject({ method: "DELETE", url: "/me", headers: rig.as(leaving.token) })).statusCode).toBe(204);
    // Laporan yang belum terbit ikut terhapus bersama antreannya (ADR-0024).
    expect(await queued(id)).toEqual([]);
  });
});
