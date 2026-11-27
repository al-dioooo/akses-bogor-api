import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { exportAccount, EXPORT_NOTES, writeExportFile, type AccountExport } from "../src/data-subject/export.js";
import { recordRequest } from "../src/data-subject/requests.js";
import { auditLog, sessions, verifications } from "../src/db/schema.js";
import { facilities, verificationRig, type Rig } from "./helpers/verification.js";

let rig: Rig;
let reporter: { token: string; user: { id: string } };
let verifier: { token: string; user: { id: string } };
let admin: { token: string; user: { id: string } };
let requestId: number;
let data: AccountExport;
let dir: string;

const post = (url: string, payload: object, token = verifier.token) => rig.app.inject({ method: "POST", url, headers: rig.as(token), payload });
const checked = () => facilities({ ramp: { answer: "tersedia" } }).map((f) => ({ reason: null, note: null, evidence: "terbukti", ...f }));

beforeAll(async () => {
  rig = await verificationRig();
  reporter = await rig.helpers.reporter("pelapor@contoh.id", "Warga Bogor");
  verifier = await rig.verifier("vera@contoh.id", "Vera Pemeriksa");
  admin = await rig.verifier("admin@contoh.id", "Adi Admin", "admin");

  const photo = await rig.uploadPhoto(reporter.token);
  const published = await rig.submit(reporter.token, { ...rig.newPlace(), photos: [{ id: photo, tag: "pintu_masuk" }] });
  await post(`/verifier/reports/${published}/clarify`, { question: "Ada foto ramp dari dekat?", note: "catatan internal pertama" });
  await post(`/me/reports/${published}/clarification`, { answer: "Foto pertama sudah dari dekat." }, reporter.token);
  await post(`/verifier/reports/${published}/publish`, { name: "Masjid Al-Ikhlas contoh", category: "masjid", location: { lat: -6.5976, lng: 106.7991 }, description: null, facilities: checked(), note: "catatan internal kedua" });
  const rejected = await rig.submit(reporter.token, rig.newPlace({ name: "Kampus tolak contoh" }));
  await post(`/verifier/reports/${rejected}/reject`, { reason: "duplikat", note: "catatan internal ketiga" });
  await rig.uploadPhoto(reporter.token);

  ({ id: requestId } = await recordRequest(rig.db, { kind: "salinan", userId: reporter.user.id, receivedAt: rig.clock.now, handler: { id: admin.user.id }, now: rig.clock.now }));
  data = await exportAccount(rig.db, { userId: reporter.user.id, requestId, handler: { id: admin.user.id }, now: rig.clock.now });
  dir = await mkdtemp(join(tmpdir(), "ekspor-"));
}, 120_000);

afterAll(async () => {
  await rig.close();
  await rm(dir, { recursive: true, force: true });
});

describe("exporting an account", () => {
  it("includes the account with its consent time and version", () => {
    expect(data).toMatchObject({ format: "aksesbogor-ekspor-akun", versi: 1, permintaan: requestId });
    expect(data.akun).toMatchObject({ id: reporter.user.id, displayName: "Warga Bogor", email: "pelapor@contoh.id", role: "pengguna", reportEmailsOffAt: null });
    expect(data.akun.privacyConsentAt).toEqual(expect.any(String));
    expect(data.akun.privacyPolicyVersion).toEqual(expect.any(String));
  });

  it("includes reports with their submission, photos, and clarification answers", () => {
    expect(data.laporan).toHaveLength(2);
    const published = data.laporan.find((r) => r.status === "diterbitkan");
    const rejected = data.laporan.find((r) => r.status === "ditolak");
    expect(published).toMatchObject({ placeName: "Masjid Al-Ikhlas contoh", submission: expect.objectContaining({ name: "Masjid Al-Ikhlas contoh" }), location: { lat: -6.5976, lng: 106.7991 } });
    expect(published!.photos).toEqual([expect.objectContaining({ tag: "pintu_masuk", moderation: "tayang" })]);
    expect(published!.clarifications).toEqual([expect.objectContaining({ question: "Ada foto ramp dari dekat?", answer: "Foto pertama sudah dari dekat." })]);
    expect(rejected).toMatchObject({ rejectionReason: "duplikat", photos: [] });
    expect(data.fotoBelumDipasang).toHaveLength(1);
  });

  it("includes sessions, the request, and audit entries about the account with who acted", () => {
    expect(data.sesi.length).toBeGreaterThan(0);
    expect(data.permintaanHakSubjek).toEqual([expect.objectContaining({ id: requestId, kind: "salinan", completedAt: null })]);
    const actions = data.logAudit.map((e) => `${e.action}:${e.oleh}`);
    expect(actions).toEqual(expect.arrayContaining(["klarifikasi_dijawab:akun ini", "data_diekspor:tim AksesBogor", "permintaan_dicatat:tim AksesBogor"]));
    expect(data.logAudit.some((e) => e.entityType === "laporan" && e.action === "ditolak" && e.oleh === "tim AksesBogor")).toBe(true);
  });

  it("explains every section in Bahasa Indonesia", () => {
    const sections = Object.keys(data).filter((k) => !["format", "versi", "dibuat", "permintaan", "catatan"].includes(k));
    expect(Object.keys(EXPORT_NOTES).sort()).toEqual(["umum", ...sections].sort());
    expect(data.catatan).toBe(EXPORT_NOTES);
  });

  it("leaves out session tokens, login codes, internal notes, and team members", async () => {
    const text = JSON.stringify(data);
    for (const { token } of await rig.db.select({ token: sessions.token }).from(sessions)) expect(text).not.toContain(token);
    for (const { value } of await rig.db.select({ value: verifications.value }).from(verifications)) expect(text).not.toContain(value);
    expect(text).not.toContain("catatan internal");
    for (const leaked of ["vera@contoh.id", "Vera Pemeriksa", verifier.user.id, "admin@contoh.id", "Adi Admin", admin.user.id]) expect(text).not.toContain(leaked);
  });

  it("records the export in the audit log with the request number", async () => {
    const entries = await rig.db.select().from(auditLog).where(eq(auditLog.action, "data_diekspor"));
    expect(entries).toEqual([expect.objectContaining({ entityType: "pengguna", entityId: reporter.user.id, actorId: admin.user.id, changes: { permintaan: requestId } })]);
  });

  it("lists what a team member decided", async () => {
    const own = await exportAccount(rig.db, { userId: verifier.user.id, requestId, handler: { id: admin.user.id }, now: rig.clock.now });
    expect(own.laporan).toEqual([]);
    expect(own.sebagaiTim.laporanDiputuskan).toHaveLength(2);
    expect(own.sebagaiTim.pertanyaanKlarifikasi).toEqual([expect.objectContaining({ question: "Ada foto ramp dari dekat?" })]);
    expect(own.logAudit.filter((e) => e.oleh === "akun ini").length).toBeGreaterThan(0);
    expect(JSON.stringify(own)).not.toContain("pelapor@contoh.id");
  });
});

describe("writing the export file", () => {
  it("writes a new file readable only by its owner", async () => {
    const path = join(dir, "ekspor.json");
    await writeExportFile(path, async () => ({ ok: true }));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ok: true });
  });

  it("never overwrites an existing file and does not export when it cannot write", async () => {
    const path = join(dir, "ada.json");
    await writeFile(path, "lama");
    let produced = false;
    await expect(writeExportFile(path, async () => (produced = true))).rejects.toMatchObject({ code: "EEXIST" });
    expect(produced).toBe(false);
    expect(await readFile(path, "utf8")).toBe("lama");
  });

  it("removes the file when the export fails", async () => {
    const path = join(dir, "gagal.json");
    await expect(writeExportFile(path, async () => Promise.reject(new Error("database mati")))).rejects.toThrow("database mati");
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
