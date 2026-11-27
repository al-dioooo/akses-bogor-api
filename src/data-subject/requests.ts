// Permintaan hak subjek data (Kebijakan Privasi bagian "Hak Anda", UU No. 27/2022). Permintaan masuk lewat email kontak
// dan dijawab paling lambat 3 × 24 jam. Setiap permintaan dicatat di `data_subject_requests`; skrip `hak-subjek:*`
// lain menyebut nomornya, dan log audit mencatat admin yang menjalankannya. Tanpa email, nama, atau isi permintaan.
import { asc, eq, isNull, sql } from "drizzle-orm";
import { audit } from "../audit/log.js";
import type { Db } from "../db/client.js";
import { dataSubjectRequests, users, type dataSubjectRequestKind, type dataSubjectRequestOutcome } from "../db/schema.js";
import { HttpError } from "../http/errors.js";

export type RequestKind = (typeof dataSubjectRequestKind.enumValues)[number];
export type RequestOutcome = (typeof dataSubjectRequestOutcome.enumValues)[number];

/** Batas jawaban yang dijanjikan Kebijakan Privasi. */
export const RESPONSE_HOURS = 72;
const HOUR_MS = 60 * 60 * 1000;
export const responseDue = (receivedAt: Date) => new Date(receivedAt.getTime() + RESPONSE_HOURS * HOUR_MS);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Akun dari id atau email (tanpa membedakan huruf besar). */
export async function findAccount(db: Db, ref: string) {
  const value = ref.trim();
  const [account] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(UUID.test(value) ? eq(users.id, value.toLowerCase()) : eq(sql`lower(${users.email})`, value.toLowerCase()));
  if (!account) throw new HttpError(404, "akun_tidak_ditemukan", "Tidak ada akun dengan email atau id itu.");
  return account;
}

/** Admin yang menjalankan skrip. Hanya admin yang menangani permintaan hak subjek data. */
export async function findHandler(db: Db, email: string) {
  const [handler] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(sql`lower(${users.email})`, email.trim().toLowerCase()));
  if (handler?.role !== "admin") throw new HttpError(403, "bukan_admin", "--oleh harus email akun admin AksesBogor.");
  return { id: handler.id };
}

/**
 * Waktu diterima dari baris perintah: ISO 8601, atau "YYYY-MM-DD HH:MM" yang dibaca sebagai WIB. Tidak boleh di masa
 * depan, supaya tenggat tidak mundur karena salah ketik.
 */
export function parseReceivedAt(value: string, now: Date) {
  const local = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(value.trim());
  const date = new Date(local ? `${value.trim().replace(" ", "T")}+07:00` : value.trim());
  if (Number.isNaN(date.getTime())) throw new HttpError(400, "waktu_tidak_sah", "--diterima harus berupa waktu, mis. \"2026-11-27 09:15\" (WIB).");
  if (date.getTime() > now.getTime() + 5 * 60 * 1000) throw new HttpError(400, "waktu_di_masa_depan", "--diterima tidak boleh di masa depan.");
  return date;
}

type Handler = { id: string };

export async function recordRequest(db: Db, input: { kind: RequestKind; userId: string | null; receivedAt: Date; handler: Handler; now: Date }) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(dataSubjectRequests)
      .values({ kind: input.kind, userId: input.userId, receivedAt: input.receivedAt, handledBy: input.handler.id, createdAt: input.now })
      .returning({ id: dataSubjectRequests.id });
    if (input.userId) {
      await audit(tx, { entity: "pengguna", entityId: input.userId, actor: { userId: input.handler.id }, action: "permintaan_dicatat", changes: { permintaan: row!.id, jenis: input.kind }, at: input.now });
    }
    return { id: row!.id, dueAt: responseDue(input.receivedAt) };
  });
}

const requestNotFound = (id: number) => new HttpError(404, "permintaan_tidak_ditemukan", `Permintaan #${id} tidak ada.`);

/** Menandai permintaan selesai atau ditolak. Penolakan wajib menyebut alasannya (Kebijakan Privasi, Pasal 33). */
export async function closeRequest(db: Db, id: number, input: { outcome: RequestOutcome; note: string | null; handler: Handler; now: Date }) {
  if (input.outcome === "ditolak" && !input.note?.trim()) throw new HttpError(400, "alasan_wajib", "Penolakan harus menyebut alasannya.");
  return db.transaction(async (tx) => {
    const [request] = await tx.select().from(dataSubjectRequests).where(eq(dataSubjectRequests.id, id)).for("update");
    if (!request) throw requestNotFound(id);
    if (request.completedAt) throw new HttpError(409, "permintaan_sudah_ditutup", `Permintaan #${id} sudah ditutup.`);
    await tx
      .update(dataSubjectRequests)
      .set({ completedAt: input.now, outcome: input.outcome, note: input.note?.trim() || null })
      .where(eq(dataSubjectRequests.id, id));
    if (request.userId) {
      await audit(tx, { entity: "pengguna", entityId: request.userId, actor: { userId: input.handler.id }, action: `permintaan_${input.outcome}`, changes: { permintaan: id }, at: input.now });
    }
    const late = input.now.getTime() > responseDue(request.receivedAt).getTime();
    return { kind: request.kind, late };
  });
}

/** Permintaan yang belum ditutup, yang paling lama diterima dulu. */
export async function listOpenRequests(db: Db) {
  const rows = await db
    .select({ id: dataSubjectRequests.id, kind: dataSubjectRequests.kind, userId: dataSubjectRequests.userId, receivedAt: dataSubjectRequests.receivedAt })
    .from(dataSubjectRequests)
    .where(isNull(dataSubjectRequests.completedAt))
    .orderBy(asc(dataSubjectRequests.receivedAt), asc(dataSubjectRequests.id));
  return rows.map((r) => ({ ...r, dueAt: responseDue(r.receivedAt) }));
}

/**
 * Permintaan terbuka yang dipakai skrip lain. Harus untuk akun yang sama dan berjenis yang cocok, supaya nomor yang salah
 * ketik tidak menjalankan tindakan untuk orang lain.
 */
export async function openRequestFor(db: Db, id: number, userId: string, kinds: readonly RequestKind[]) {
  const [request] = await db
    .select({ id: dataSubjectRequests.id, kind: dataSubjectRequests.kind, userId: dataSubjectRequests.userId, completedAt: dataSubjectRequests.completedAt })
    .from(dataSubjectRequests)
    .where(eq(dataSubjectRequests.id, id));
  if (!request) throw requestNotFound(id);
  if (request.completedAt) throw new HttpError(409, "permintaan_sudah_ditutup", `Permintaan #${id} sudah ditutup. Catat permintaan baru dengan hak-subjek:catat.`);
  if (request.userId !== userId) throw new HttpError(409, "permintaan_akun_lain", `Permintaan #${id} bukan untuk akun ini.`);
  if (!kinds.includes(request.kind)) throw new HttpError(409, "jenis_permintaan_tidak_cocok", `Permintaan #${id} berjenis ${request.kind}; skrip ini untuk ${kinds.join(" atau ")}.`);
  return request;
}
