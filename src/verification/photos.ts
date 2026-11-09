// Foto laporan untuk verifikator (FR-34, ADR-0037): membaca foto yang belum terbit dan menyimpan moderasinya. Foto
// laporan sendiri tidak bisa dibuka (FR-37), dan foto laporan yang sudah diputuskan tidak bisa diubah.
import { and, eq } from "drizzle-orm";
import { audit } from "../audit/log.js";
import type { Db } from "../db/client.js";
import { photos, reports, type BlurRegion } from "../db/schema.js";
import { HttpError } from "../http/errors.js";
import { ownReport, reportNotFound } from "./queue.js";

export const photoNotFound = () => new HttpError(404, "foto_tidak_ditemukan", "Foto ini tidak ditemukan atau sudah terbit.");
export const alreadyDecided = () => new HttpError(409, "sudah_diputuskan", "Laporan ini sudah diputuskan. Muat ulang halaman untuk melihat hasilnya.");

/** Laporan yang masih bisa diputuskan. */
export const REVIEWABLE = ["menunggu", "klarifikasi"] as const;
export const isReviewable = (status: string) => (REVIEWABLE as readonly string[]).includes(status);

/** Foto laporan yang belum terbit, untuk dibuka verifikator. */
export async function photoForReview(db: Db, viewerId: string, photoId: string) {
  const [row] = await db
    .select({ storageKey: photos.storageKey, blur: photos.blurRegions, moderation: photos.moderation, reporterId: reports.reporterId })
    .from(photos)
    .innerJoin(reports, eq(reports.id, photos.reportId))
    .where(eq(photos.id, photoId));
  if (!row || row.moderation === "tayang" || !row.storageKey.startsWith("laporan/")) throw photoNotFound();
  if (row.reporterId === viewerId) throw ownReport();
  return { storageKey: row.storageKey, blur: row.blur ?? [] };
}

export type ModerationPatch = {
  hidden?: boolean;
  tag?: (typeof photos.tag.enumValues)[number];
  caption?: string | null;
  blur?: BlurRegion[];
};

/** Menyimpan moderasi satu foto sebelum keputusan laporan, dan mencatatnya di log audit (ADR-0038). */
export async function moderatePhoto(db: Db, viewerId: string, reportId: string, photoId: string, patch: ModerationPatch, now: Date) {
  return db.transaction(async (tx) => {
    const [report] = await tx.select({ status: reports.status, reporterId: reports.reporterId }).from(reports).where(eq(reports.id, reportId)).for("update");
    if (!report) throw reportNotFound();
    if (report.reporterId === viewerId) throw ownReport();
    if (!isReviewable(report.status)) throw alreadyDecided();
    const [photo] = await tx
      .select({ tag: photos.tag, caption: photos.caption, moderation: photos.moderation, blur: photos.blurRegions })
      .from(photos)
      .where(and(eq(photos.id, photoId), eq(photos.reportId, reportId)));
    if (!photo) throw photoNotFound();

    const next = {
      tag: patch.tag ?? photo.tag,
      caption: patch.caption === undefined ? photo.caption : patch.caption,
      moderation: patch.hidden === undefined ? photo.moderation : patch.hidden ? ("disembunyikan" as const) : ("menunggu" as const),
      blurRegions: patch.blur === undefined ? photo.blur : patch.blur.length > 0 ? patch.blur : null,
    };
    const [row] = await tx
      .update(photos)
      .set(next)
      .where(eq(photos.id, photoId))
      .returning({ id: photos.id, tag: photos.tag, caption: photos.caption, alt: photos.altText, width: photos.width, height: photos.height, moderation: photos.moderation, blur: photos.blurRegions, clarificationId: photos.clarificationId });

    // Isi keterangan tidak dicatat; hanya tag, disembunyikan, dan jumlah area (ADR-0038).
    const changes: Record<string, { sebelum: unknown; sesudah: unknown }> = {};
    if (next.tag !== photo.tag) changes.tag = { sebelum: photo.tag, sesudah: next.tag };
    if (next.moderation !== photo.moderation) changes.disembunyikan = { sebelum: photo.moderation === "disembunyikan", sesudah: next.moderation === "disembunyikan" };
    if ((next.blurRegions?.length ?? 0) !== (photo.blur?.length ?? 0)) changes.areaKabur = { sebelum: photo.blur?.length ?? 0, sesudah: next.blurRegions?.length ?? 0 };
    if (Object.keys(changes).length > 0) {
      await audit(tx, { entity: "foto", entityId: photoId, actor: { userId: viewerId }, action: "dimoderasi", changes: { ...changes, laporan: reportId }, at: now });
    }
    const { moderation, blur, ...rest } = row!;
    return { ...rest, hidden: moderation === "disembunyikan", blur: blur ?? [] };
  });
}
