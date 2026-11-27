// Salinan data akun untuk permintaan hak akses dan portabilitas (UU No. 27/2022 Pasal 13 dan 32). Semua yang disimpan
// tentang akun ditulis ke satu berkas JSON, dengan `catatan` per bagian dalam bahasa Indonesia. Yang sengaja tidak ikut:
// kunci sesi dan hash kode masuk (bisa dipakai untuk masuk), catatan internal verifikator (ADR-0036), dan identitas
// anggota tim lain (data pribadi orang lain).
import { open, rm } from "node:fs/promises";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { audit } from "../audit/log.js";
import type { Db } from "../db/client.js";
import { accounts, auditLog, dataSubjectRequests, photos, places, reportClarifications, reportEmails, reports, sessions, users, verifications } from "../db/schema.js";
import { HttpError } from "../http/errors.js";

export const EXPORT_NOTES = {
  umum: "Salinan semua data yang disimpan AksesBogor tentang akun ini saat berkas dibuat (`dibuat`), untuk permintaan bernomor `permintaan`. Waktu ditulis dalam UTC (ISO 8601); tambahkan 7 jam untuk WIB. Berkas ini bisa dibaca komputer dan dibawa ke layanan lain.",
  akun: "Nama tampilan, email, peran, serta waktu dan versi Kebijakan Privasi yang Anda setujui. `reportEmailsOffAt` terisi bila Anda meminta email status laporan dihentikan. Foto profil Google tidak disimpan.",
  tautanLogin: "Akun Google yang tertaut untuk masuk. `accountId` adalah nomor akun Google Anda, bukan email. Token dari Google tidak disimpan.",
  sesi: "Sesi masuk yang masih tersimpan. Kunci sesi tidak disertakan supaya berkas ini tidak bisa dipakai untuk masuk. Alamat IP dan jenis perangkat tidak disimpan.",
  kodeMasuk: "Kode masuk lewat email yang belum dibersihkan. Hanya waktunya; kodenya disimpan teracak dan tidak disertakan.",
  laporan: "Laporan yang Anda kirim: isian apa adanya (`submission`), titik lokasi, status, data foto, serta pertanyaan dan jawaban klarifikasi. Berkas fotonya tidak ikut; minta lewat email kontak bila Anda ingin salinannya. Catatan internal verifikator dan siapa verifikatornya tidak disertakan karena berisi penilaian dan data orang lain.",
  fotoBelumDipasang: "Foto yang sudah diunggah tetapi belum menjadi bagian laporan. Foto seperti ini dihapus otomatis bila tidak dipakai.",
  emailStatusLaporan: "Email status laporan yang masih menunggu dikirim. AksesBogor tidak menyimpan catatan email yang sudah terkirim.",
  permintaanHakSubjek: "Permintaan hak subjek data yang pernah Anda kirim ke AksesBogor, termasuk permintaan ini.",
  logAudit:
    "Catatan kapan data Anda diproses: perubahan pada akun, laporan, dan foto Anda, serta tindakan yang Anda lakukan sendiri. `oleh` berisi `akun ini`, `tim AksesBogor`, `sistem` (tugas otomatis), `skrip` (dijalankan tim di server), atau `akun yang sudah dihapus`.",
  sebagaiTim: "Hanya terisi bila akun ini anggota tim: laporan yang Anda putuskan, pertanyaan klarifikasi yang Anda ajukan, dan tempat yang Anda terbitkan langsung sebagai admin.",
};

const iso = (value: Date | null) => (value ? new Date(value).toISOString() : null);
const OTP_PREFIXES = ["sign-in-otp-", "email-verification-otp-", "forget-password-otp-"];
const none = [crypto.randomUUID()];

/**
 * Membaca semua data akun dalam satu snapshot dan mencatat ekspornya di log audit (entri itu ikut terbaca). Admin yang
 * menjalankan tercatat sebagai pelaku, dengan nomor permintaannya.
 */
export async function exportAccount(db: Db, input: { userId: string; requestId: number; handler: { id: string }; now: Date }) {
  const { userId, now } = input;
  return db.transaction(
    async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, userId));
      if (!user) throw new HttpError(404, "akun_tidak_ditemukan", "Akun ini tidak ada.");
      await audit(tx, { entity: "pengguna", entityId: userId, actor: { userId: input.handler.id }, action: "data_diekspor", changes: { permintaan: input.requestId }, at: now });

      const ownReports = await tx
        .select({
          id: reports.id,
          kind: reports.kind,
          status: reports.status,
          placeId: reports.placeId,
          placeName: places.name,
          submission: reports.submission,
          location: reports.location,
          districtSlug: reports.districtSlug,
          submissionKey: reports.submissionKey,
          submittedAt: reports.submittedAt,
          decidedAt: reports.decidedAt,
          rejectionReason: reports.rejectionReason,
          clarificationQuestion: reports.clarificationQuestion,
          clarificationDueAt: reports.clarificationDueAt,
          heldAt: reports.heldAt,
          holdReason: reports.holdReason,
        })
        .from(reports)
        .leftJoin(places, eq(places.id, reports.placeId))
        .where(eq(reports.reporterId, userId))
        .orderBy(asc(reports.submittedAt), asc(reports.id));
      const reportIds = ownReports.length ? ownReports.map((r) => r.id) : none;

      const photoColumns = {
        id: photos.id,
        reportId: photos.reportId,
        placeId: photos.placeId,
        clarificationId: photos.clarificationId,
        tag: photos.tag,
        altText: photos.altText,
        caption: photos.caption,
        width: photos.width,
        height: photos.height,
        bytes: photos.bytes,
        moderation: photos.moderation,
        blurRegions: photos.blurRegions,
        createdAt: photos.createdAt,
      };
      const [ownPhotos, clarifications, links, ownSessions, codes, emails, requests] = await Promise.all([
        tx.select(photoColumns).from(photos).where(or(inArray(photos.reportId, reportIds), eq(photos.uploaderId, userId))).orderBy(asc(photos.createdAt), asc(photos.id)),
        tx
          .select({ id: reportClarifications.id, reportId: reportClarifications.reportId, question: reportClarifications.question, askedAt: reportClarifications.askedAt, dueAt: reportClarifications.dueAt, answer: reportClarifications.answer, answeredAt: reportClarifications.answeredAt })
          .from(reportClarifications)
          .where(inArray(reportClarifications.reportId, reportIds))
          .orderBy(asc(reportClarifications.askedAt)),
        tx.select({ providerId: accounts.providerId, accountId: accounts.accountId, createdAt: accounts.createdAt, updatedAt: accounts.updatedAt }).from(accounts).where(eq(accounts.userId, userId)),
        tx.select({ id: sessions.id, createdAt: sessions.createdAt, updatedAt: sessions.updatedAt, expiresAt: sessions.expiresAt }).from(sessions).where(eq(sessions.userId, userId)).orderBy(asc(sessions.createdAt)),
        tx
          .select({ createdAt: verifications.createdAt, expiresAt: verifications.expiresAt })
          .from(verifications)
          .where(inArray(verifications.identifier, OTP_PREFIXES.map((p) => `${p}${user.email}`))),
        tx.select({ reportId: reportEmails.reportId, kind: reportEmails.kind, attempts: reportEmails.attempts, createdAt: reportEmails.createdAt, nextAttemptAt: reportEmails.nextAttemptAt }).from(reportEmails).where(inArray(reportEmails.reportId, reportIds)),
        tx
          .select({ id: dataSubjectRequests.id, kind: dataSubjectRequests.kind, receivedAt: dataSubjectRequests.receivedAt, completedAt: dataSubjectRequests.completedAt, outcome: dataSubjectRequests.outcome, note: dataSubjectRequests.note })
          .from(dataSubjectRequests)
          .where(eq(dataSubjectRequests.userId, userId))
          .orderBy(asc(dataSubjectRequests.receivedAt)),
      ]);
      const photoIds = ownPhotos.length ? ownPhotos.map((p) => p.id) : none;

      const [entries, reviewed, asked, adminPlaces] = await Promise.all([
        tx
          .select()
          .from(auditLog)
          .where(
            or(
              and(eq(auditLog.entityType, "pengguna"), eq(auditLog.entityId, userId)),
              and(eq(auditLog.entityType, "laporan"), inArray(auditLog.entityId, reportIds)),
              and(eq(auditLog.entityType, "foto"), inArray(auditLog.entityId, photoIds)),
              eq(auditLog.actorId, userId),
            ),
          )
          .orderBy(asc(auditLog.createdAt), asc(auditLog.id)),
        tx.select({ id: reports.id, status: reports.status, decidedAt: reports.decidedAt }).from(reports).where(eq(reports.reviewerId, userId)).orderBy(asc(reports.decidedAt)),
        tx.select({ reportId: reportClarifications.reportId, question: reportClarifications.question, askedAt: reportClarifications.askedAt }).from(reportClarifications).where(eq(reportClarifications.askedBy, userId)).orderBy(asc(reportClarifications.askedAt)),
        tx.select({ id: places.id, name: places.name, adminPublishedAt: places.adminPublishedAt }).from(places).where(eq(places.adminPublishedBy, userId)).orderBy(asc(places.adminPublishedAt)),
      ]);

      const photo = ({ createdAt, blurRegions, ...p }: (typeof ownPhotos)[number]) => ({ ...p, blurRegions: blurRegions ?? [], createdAt: iso(createdAt) });
      const actor = (e: (typeof entries)[number]) =>
        e.actorId === userId ? "akun ini" : e.actorLabel ? e.actorLabel : e.actorId ? "tim AksesBogor" : "akun yang sudah dihapus";

      return {
        format: "aksesbogor-ekspor-akun",
        versi: 1,
        dibuat: iso(now),
        permintaan: input.requestId,
        catatan: EXPORT_NOTES,
        akun: {
          id: user.id,
          displayName: user.displayName,
          email: user.email,
          emailVerified: user.emailVerified,
          role: user.role,
          privacyConsentAt: iso(user.privacyConsentAt),
          privacyPolicyVersion: user.privacyPolicyVersion,
          reportEmailsOffAt: iso(user.reportEmailsOffAt),
          createdAt: iso(user.createdAt),
          updatedAt: iso(user.updatedAt),
        },
        tautanLogin: links.map((l) => ({ ...l, createdAt: iso(l.createdAt), updatedAt: iso(l.updatedAt) })),
        sesi: ownSessions.map((s) => ({ id: s.id, createdAt: iso(s.createdAt), updatedAt: iso(s.updatedAt), expiresAt: iso(s.expiresAt) })),
        kodeMasuk: codes.map((c) => ({ createdAt: iso(c.createdAt), expiresAt: iso(c.expiresAt) })),
        laporan: ownReports.map(({ location, submittedAt, decidedAt, clarificationDueAt, heldAt, ...r }) => ({
          ...r,
          location: location ? { lat: location.y, lng: location.x } : null,
          submittedAt: iso(submittedAt),
          decidedAt: iso(decidedAt),
          clarificationDueAt: iso(clarificationDueAt),
          heldAt: iso(heldAt),
          photos: ownPhotos.filter((p) => p.reportId === r.id).map(photo),
          clarifications: clarifications.filter((c) => c.reportId === r.id).map(({ askedAt, dueAt, answeredAt, ...c }) => ({ ...c, askedAt: iso(askedAt), dueAt: iso(dueAt), answeredAt: iso(answeredAt) })),
        })),
        fotoBelumDipasang: ownPhotos.filter((p) => p.reportId === null).map(photo),
        emailStatusLaporan: emails.map((e) => ({ ...e, createdAt: iso(e.createdAt), nextAttemptAt: iso(e.nextAttemptAt) })),
        permintaanHakSubjek: requests.map((r) => ({ ...r, receivedAt: iso(r.receivedAt), completedAt: iso(r.completedAt) })),
        logAudit: entries.map((e) => ({ id: e.id, entityType: e.entityType, entityId: e.entityId, action: e.action, changes: e.changes, oleh: actor(e), createdAt: iso(e.createdAt) })),
        sebagaiTim: {
          laporanDiputuskan: reviewed.map((r) => ({ ...r, decidedAt: iso(r.decidedAt) })),
          pertanyaanKlarifikasi: asked.map((q) => ({ ...q, askedAt: iso(q.askedAt) })),
          tempatDiterbitkanAdmin: adminPlaces.map((p) => ({ ...p, adminPublishedAt: iso(p.adminPublishedAt) })),
        },
      };
    },
    { isolationLevel: "repeatable read" },
  );
}

export type AccountExport = Awaited<ReturnType<typeof exportAccount>>;

/**
 * Membuka berkas baru dengan mode 600 dulu, baru menjalankan `produce`, supaya path yang salah atau sudah ada gagal
 * sebelum ekspor dicatat di log audit. Berkas yang sudah ada tidak ditimpa. Bila `produce` gagal, berkas kosongnya dihapus.
 */
export async function writeExportFile<T>(path: string, produce: () => Promise<T>) {
  const file = await open(path, "wx", 0o600);
  let written = false;
  try {
    const data = await produce();
    await file.writeFile(`${JSON.stringify(data, null, 2)}\n`);
    written = true;
    return data;
  } finally {
    await file.close();
    if (!written) await rm(path, { force: true });
  }
}
