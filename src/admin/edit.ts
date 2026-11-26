// Tambah, ubah, turunkan, dan tayangkan lagi tempat oleh admin (ADR-0051). Tambah dan ubah dibuat sebagai laporan milik
// admin yang langsung diterbitkan lewat `publishReport`, jadi foto, kecamatan, status, dan log audit memakai jalur yang
// sama dengan verifikasi. Hanya dipanggil route `/admin/*` yang sudah memeriksa peran admin.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { audit } from "../audit/log.js";
import type { Db } from "../db/client.js";
import { photos, places } from "../db/schema.js";
import { FACILITIES, type Answer, type Facility, type Reason } from "../domain/status.js";
import { HttpError } from "../http/errors.js";
import type { PhotoStore } from "../photos/storage.js";
import type { ReportBody } from "../reports/schemas.js";
import { existing, insertReport, isDuplicateSubmission, prepareReport } from "../reports/submit.js";
import { inPublishTransaction, publishInTransaction, type FinalFacility } from "../verification/publish.js";
import { placeNotFound } from "./places.js";

type PhotoTag = (typeof photos.tag.enumValues)[number];
type Log = { warn: (obj: object, msg: string) => void };

/** Tag foto yang menjadi bukti setiap fasilitas (Panduan Verifikasi bagian 5, ADR-0023). */
export const EVIDENCE_TAG: Record<Facility, PhotoTag> = { ramp: "pintu_masuk", toilet_difabel: "toilet_difabel", guiding_block: "guiding_block", lift: "lift" };
/** Jawaban yang harus terlihat di foto (Panduan Verifikasi bagian 2). */
const NEEDS_PHOTO: readonly Answer[] = ["tersedia", "tidak_perlu"];

export type FacilityAnswer = { facility: Facility; answer: Answer; reason?: Reason | null; note?: string | null };

/**
 * Jawaban akhir untuk terbit langsung: Tersedia dan Tidak perlu tanpa foto bertag fasilitas itu menjadi Tanpa bukti, jadi
 * disimpan sebagai Belum tahu seperti saat verifikasi (ADR-0036, ADR-0051). `downgraded` menyebut fasilitas yang berubah.
 */
export function directAnswers(items: readonly FacilityAnswer[], tags: Iterable<PhotoTag>) {
  const shown = new Set(tags);
  const final: FinalFacility[] = FACILITIES.map((facility) => {
    const item = items.find((f) => f.facility === facility) ?? { facility, answer: "belum_tahu" as const };
    const proven = !NEEDS_PHOTO.includes(item.answer) || shown.has(EVIDENCE_TAG[facility]);
    return { facility, answer: item.answer, reason: item.reason ?? null, note: item.note ?? null, evidence: proven ? "terbukti" : "tanpa_bukti" };
  });
  return { final, downgraded: final.filter((f) => f.evidence === "tanpa_bukti").map((f) => f.facility) };
}

export type AdminPlaceBody = {
  name: string;
  category: NonNullable<ReportBody["category"]>;
  location: { lat: number; lng: number };
  landmark?: string | null;
  description?: string | null;
  facilities: FacilityAnswer[];
  photos: { id: string; tag: PhotoTag; caption?: string }[];
  reason: string;
  osm?: { type: string; id: number };
};

/** Diperiksa sebelum transaksi dibuka, supaya isian yang pasti ditolak tidak sampai mengunci apa pun. */
function precheck(body: Pick<AdminPlaceBody, "facilities" | "photos">, store: PhotoStore | undefined) {
  if (body.facilities.some((f) => f.answer === "tidak_tersedia" && !f.reason)) {
    throw new HttpError(400, "alasan_wajib", "Setiap jawaban Tidak tersedia butuh alasan sebelum diterbitkan.");
  }
  if (body.photos.length > 0 && !store) throw new HttpError(503, "foto_belum_diatur", "Penyimpanan foto belum diatur di server.");
}

const reportOf = (body: AdminPlaceBody, kind: "baru" | "perubahan", placeId?: string): ReportBody => ({
  submissionKey: randomUUID(),
  kind,
  placeId,
  name: body.name,
  category: body.category,
  location: body.location,
  landmark: body.landmark ?? undefined,
  description: body.description ?? undefined,
  facilities: body.facilities.map((f) => ({ facility: f.facility, answer: f.answer, reason: f.reason ?? undefined, note: f.note ?? undefined })),
  photos: body.photos,
});

type DirectInput = Pick<AdminPlaceBody, "facilities" | "reason" | "osm"> & Partial<Pick<AdminPlaceBody, "name" | "category" | "location" | "landmark" | "description">>;

/**
 * Laporan admin disimpan dan diterbitkan dalam **satu** transaksi (ADR-0051), jadi laporan berstatus menunggu tidak pernah
 * terlihat di antrean verifikasi dan tidak bisa diambil verifikator di tengah jalan. Bila terbit gagal, laporan dan
 * pemasangan fotonya ikut batal: foto kembali milik admin. `tags` menghitung foto tayang tempat itu yang tetap ada, dibaca
 * di dalam transaksi yang sama.
 */
async function submitAndPublish(
  db: Db,
  store: PhotoStore | undefined,
  adminId: string,
  report: ReportBody,
  body: DirectInput,
  now: Date,
  log: Log | undefined,
  extra: { version?: (tx: Db) => Promise<string | undefined>; keptTags: (tx: Db) => Promise<PhotoTag[]>; removePhotoIds?: string[] },
) {
  const prepared = await prepareReport(db, report);
  const result = await inPublishTransaction(db, store, log, async (tx, copied) => {
    const row = await insertReport(tx, adminId, report, prepared, now);
    const { final, downgraded } = directAnswers(body.facilities, [...(await extra.keptTags(tx)), ...report.photos.map((p) => p.tag)]);
    const published = await publishInTransaction(
      tx,
      store,
      adminId,
      row.id,
      { placeVersion: await extra.version?.(tx), name: body.name, category: body.category, location: body.location, landmark: body.landmark ?? null, description: body.description ?? null, facilities: final },
      now,
      copied,
      log,
      { reason: body.reason, removePhotoIds: extra.removePhotoIds, osm: body.osm },
    );
    return { ...published, report: row, downgraded };
  });
  return { placeId: result.placeId, status: result.status, downgraded: result.downgraded, report: result.report };
}

const noTags = async () => [] as PhotoTag[];
/** Foto yang sedang tayang di tempat ini. */
const shownTags = (db: Db, placeId: string) => db.select({ id: photos.id, tag: photos.tag }).from(photos).where(and(eq(photos.placeId, placeId), eq(photos.moderation, "tayang")));

/** Tempat baru yang langsung tayang sebagai tempat admin. */
export async function createPlace(db: Db, store: PhotoStore | undefined, adminId: string, body: AdminPlaceBody, now: Date, log?: Log) {
  precheck(body, store);
  const { placeId, status, downgraded } = await submitAndPublish(db, store, adminId, reportOf(body, "baru"), body, now, log, { keptTags: noTags });
  return { placeId, status, downgraded };
}

/**
 * Mengubah tempat yang masih tayang. `version` harus sama dengan `updatedAt` saat formulir dibuka; foto tayang yang tidak
 * dihapus ikut menjadi bukti jawaban.
 */
export async function updatePlace(db: Db, store: PhotoStore | undefined, adminId: string, placeId: string, body: AdminPlaceBody & { version: string; removePhotos: string[] }, now: Date, log?: Log) {
  const [place] = await db.select({ updatedAt: places.updatedAt, unpublishedAt: places.unpublishedAt }).from(places).where(eq(places.id, placeId));
  if (!place) throw placeNotFound();
  if (place.unpublishedAt) throw new HttpError(409, "lokasi_diturunkan", "Lokasi ini sedang diturunkan. Tayangkan lagi dulu sebelum mengubahnya.");
  if (place.updatedAt.toISOString() !== body.version) {
    throw new HttpError(409, "lokasi_berubah", "Data lokasi ini baru saja berubah. Muat ulang halaman dan periksa lagi dengan data terbaru.");
  }
  precheck(body, store);
  const current = await shownTags(db, placeId);
  if (body.removePhotos.some((id) => !current.some((p) => p.id === id))) {
    throw new HttpError(400, "foto_tidak_ditemukan", "Foto yang akan dihapus bukan foto tayang lokasi ini. Muat ulang halaman.");
  }
  const { status, downgraded } = await submitAndPublish(db, store, adminId, reportOf(body, "perubahan", placeId), body, now, log, {
    version: async () => body.version,
    keptTags: async (tx) => (await shownTags(tx, placeId)).filter((p) => !body.removePhotos.includes(p.id)).map((p) => p.tag),
    removePhotoIds: body.removePhotos,
  });
  return { placeId, status, downgraded };
}

/** Menurunkan tempat dari tayang dengan alasan; tidak ada yang dihapus (ADR-0051). */
export async function unpublishPlace(db: Db, adminId: string, placeId: string, reason: string, now: Date) {
  await db.transaction(async (tx) => {
    const [place] = await tx.select({ unpublishedAt: places.unpublishedAt }).from(places).where(eq(places.id, placeId)).for("update");
    if (!place) throw placeNotFound();
    if (place.unpublishedAt) throw new HttpError(409, "sudah_diturunkan", "Lokasi ini sudah diturunkan.");
    await tx.update(places).set({ unpublishedAt: now, unpublishedReason: reason, updatedAt: now }).where(eq(places.id, placeId));
    await audit(tx, { entity: "lokasi", entityId: placeId, actor: { userId: adminId }, action: "diturunkan", changes: { tayang: { sebelum: true, sesudah: false }, alasan: reason }, at: now });
  });
}

/** Menayangkan lagi tempat yang diturunkan, dengan alasan. Datanya tidak berubah. */
export async function restorePlace(db: Db, adminId: string, placeId: string, reason: string, now: Date) {
  await db.transaction(async (tx) => {
    const [place] = await tx.select({ unpublishedAt: places.unpublishedAt, unpublishedReason: places.unpublishedReason }).from(places).where(eq(places.id, placeId)).for("update");
    if (!place) throw placeNotFound();
    if (!place.unpublishedAt) throw new HttpError(409, "masih_tayang", "Lokasi ini masih tayang.");
    await tx.update(places).set({ unpublishedAt: null, unpublishedReason: null, updatedAt: now }).where(eq(places.id, placeId));
    await audit(tx, {
      entity: "lokasi",
      entityId: placeId,
      actor: { userId: adminId },
      action: "ditayangkan_lagi",
      changes: { tayang: { sebelum: false, sesudah: true }, alasanTurun: place.unpublishedReason, alasan: reason },
      at: now,
    });
  });
}


/**
 * Laporan Laporkan milik admin yang diterbitkan langsung (`publishDirectly`, ADR-0051). Untuk Edit lokasi dan Laporkan
 * kekurangan, foto tayang tempat itu ikut menjadi bukti. Kirim ulang dengan kunci draf yang sama mengembalikan laporan
 * yang sudah ada.
 */
export async function publishSubmission(db: Db, store: PhotoStore | undefined, adminId: string, body: ReportBody, reason: string, now: Date, log?: Log) {
  precheck(body, store);
  const repeat = await existing(db, adminId, body.submissionKey);
  if (repeat) return { report: repeat, downgraded: [] };
  const input = { name: body.name, category: body.category, location: body.location, landmark: body.landmark, description: body.description, facilities: body.facilities, reason };
  try {
    const { placeId, downgraded, report } = await submitAndPublish(db, store, adminId, body, input, now, log, {
      keptTags: async (tx) => (body.placeId ? (await shownTags(tx, body.placeId)).map((p) => p.tag) : []),
      version: async (tx) => {
        if (!body.placeId) return undefined;
        const [place] = await tx.select({ updatedAt: places.updatedAt }).from(places).where(eq(places.id, body.placeId));
        return place?.updatedAt.toISOString();
      },
    });
    return { report: { ...report, status: "diterbitkan" as const, placeId }, downgraded };
  } catch (error) {
    // Dua kiriman dengan kunci draf yang sama pada saat bersamaan: yang kalah mengembalikan laporan yang menang.
    const winner = isDuplicateSubmission(error) ? await existing(db, adminId, body.submissionKey) : null;
    if (winner) return { report: winner, downgraded: [] };
    throw error;
  }
}
