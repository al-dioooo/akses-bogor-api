// Menerbitkan laporan (FR-27, FR-32, FR-33, ADR-0036, ADR-0037). Satu transaksi mengunci laporan dan lokasinya, menyalin
// foto yang lolos moderasi ke bucket publik (dengan area kabur), lalu membuat atau memperbarui lokasi yang sama. Laporan
// perubahan dan kekurangan tidak pernah membuat lokasi kedua.
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { audit, diff, type AuditEntry } from "../audit/log.js";
import type { Db } from "../db/client.js";
import { photoDeletions, placeFacilities, places, photos, reports } from "../db/schema.js";
import { computeStatus, FACILITIES, type Answer, type Facility, type Reason } from "../domain/status.js";
import { HttpError } from "../http/errors.js";
import { blurPhoto } from "../photos/blur.js";
import type { PhotoStore } from "../photos/storage.js";
import { requireDistrict, type Point } from "../reports/location.js";
import { altText } from "../reports/submit.js";
import { dropReportPhotos, lockReport, queueEmail, removeQueuedFiles } from "./decide.js";

export type FinalFacility = { facility: Facility; answer: Answer; reason: Reason | null; note: string | null; evidence: "terbukti" | "tanpa_bukti" };

export type PublishInput = {
  /** `version` dari halaman pemeriksaan; wajib untuk perubahan dan kekurangan. */
  placeVersion?: string;
  name?: string;
  category?: (typeof places.category.enumValues)[number];
  location?: Point;
  landmark?: string | null;
  description: string | null;
  facilities: FinalFacility[];
  note?: string;
};

type Log = { warn: (obj: object, msg: string) => void };

/**
 * Terbit langsung oleh admin (ADR-0051): laporan milik admin itu sendiri boleh diterbitkan, tempat diberi label admin,
 * alasan masuk log audit, dan tidak ada email status. Jawaban sudah diberi bukti oleh pemanggil (`directAnswers`).
 */
export type DirectPublish = {
  reason: string;
  /** Foto tayang tempat ini yang dihapus admin di transaksi yang sama. */
  removePhotoIds?: string[];
  /** Kandidat OpenStreetMap asal tempat baru, dicatat di log audit. */
  osm?: { type: string; id: number };
};

const invalid = (code: string, message: string) => new HttpError(400, code, message);

/**
 * Jawaban akhir (FR-33): Tanpa bukti menjadi Belum tahu (ADR-0019), dan setiap Tidak tersedia yang terbukti harus punya
 * alasan (ADR-0022).
 */
export function finalAnswers(items: readonly FinalFacility[]) {
  return FACILITIES.map((facility) => {
    const item = items.find((f) => f.facility === facility)!;
    if (item.evidence === "tanpa_bukti") return { facility, answer: "belum_tahu" as const, reason: null, note: item.note };
    if (item.answer === "tidak_tersedia" && !item.reason) {
      throw invalid("alasan_wajib", "Setiap jawaban Tidak tersedia butuh alasan sebelum diterbitkan.");
    }
    return { facility, answer: item.answer, reason: item.answer === "tidak_tersedia" ? item.reason : null, note: item.note };
  });
}

type Snapshot = Record<string, unknown>;
const snapshot = (p: { name: string; category: string; districtSlug: string; location: Point; landmark: string | null; description: string | null; status: string }, facilities: ReturnType<typeof finalAnswers>): Snapshot => ({
  name: p.name,
  category: p.category,
  district: p.districtSlug,
  location: p.location,
  landmark: p.landmark,
  description: p.description,
  status: p.status,
  facilities: Object.fromEntries(facilities.map((f) => [f.facility, { answer: f.answer, reason: f.reason, note: f.note }])),
});

export async function publishReport(db: Db, store: PhotoStore | undefined, viewerId: string, id: string, input: PublishInput, now: Date, log?: Log, direct?: DirectPublish) {
  // Berkas publik yang sudah disalin; dihapus lagi bila transaksi gagal.
  const copied: string[] = [];
  try {
    const result = await db.transaction(async (tx) => {
      // FR-37 berlaku untuk verifikator; admin yang menerbitkan langsung menerbitkan laporannya sendiri (ADR-0051).
      const report = await lockReport(tx, id, direct ? null : viewerId);
      const facilities = finalAnswers(input.facilities);

      const [place] = report.placeId
        ? await tx
            .select({ id: places.id, updatedAt: places.updatedAt, name: places.name, category: places.category, districtSlug: places.districtSlug, location: places.location, landmark: places.landmark, description: places.description, status: places.status, unpublishedAt: places.unpublishedAt })
            .from(places)
            .where(eq(places.id, report.placeId))
            .for("update")
        : [];
      if (report.kind !== "baru") {
        if (!place) throw new HttpError(409, "lokasi_tidak_ada", "Lokasi yang dilaporkan sudah tidak ada. Tolak laporan ini.");
        if (place.unpublishedAt) throw new HttpError(409, "lokasi_diturunkan", "Lokasi ini sudah diturunkan admin. Tolak laporan ini, atau minta admin menayangkannya lagi.");
        if (input.placeVersion !== place.updatedAt.toISOString()) {
          throw new HttpError(409, "lokasi_berubah", "Data lokasi ini baru saja berubah. Muat ulang halaman dan periksa lagi dengan data terbaru.");
        }
      }

      // Laporan kekurangan tidak mengubah nama, kategori, titik, dan patokan (ADR-0033, ADR-0036).
      const keep = report.kind === "kekurangan" ? place! : null;
      const currentPoint = place ? { lat: place.location.y, lng: place.location.x } : null;
      const name = keep?.name ?? input.name;
      const category = keep?.category ?? input.category;
      const location = keep ? currentPoint! : input.location;
      if (!name || !category || !location) throw invalid("isian_wajib", "Nama, kategori, dan titik lokasi wajib diisi sebelum diterbitkan.");
      const landmark = keep ? keep.landmark : (input.landmark ?? null);
      const district = await requireDistrict(tx, location);
      const placeId = place?.id ?? randomUUID();
      const status = computeStatus(facilities);

      // Foto: yang disembunyikan dihapus, sisanya disalin ke bucket publik dengan area kabur (ADR-0037).
      const reportPhotos = await tx.select().from(photos).where(eq(photos.reportId, id));
      const visible = reportPhotos.filter((p) => p.moderation !== "disembunyikan");
      const hidden = reportPhotos.filter((p) => p.moderation === "disembunyikan");
      if (visible.length > 0 && !store) throw new HttpError(503, "foto_belum_diatur", "Penyimpanan foto belum diatur di server.");
      const published = [];
      for (const photo of visible) {
        const key = `lokasi/${placeId}/${photo.id}.webp`;
        try {
          const original = await store!.get(photo.storageKey);
          const output = photo.blurRegions?.length ? await blurPhoto(original, photo.blurRegions) : { data: original, width: photo.width, height: photo.height, bytes: photo.bytes };
          await store!.put(key, output.data, "image/webp");
          copied.push(key);
          published.push({ photo, key, width: output.width, height: output.height, bytes: output.bytes });
        } catch (error) {
          log?.warn({ err: error, photoId: photo.id }, "foto gagal disalin ke bucket publik");
          throw new HttpError(502, "foto_gagal_diterbitkan", "Foto gagal diterbitkan ke penyimpanan publik. Laporan belum diterbitkan; coba lagi.");
        }
      }

      const values = {
        name,
        category,
        districtSlug: district.slug,
        location: { x: location.lng, y: location.lat },
        landmark,
        description: input.description,
        status: status.status,
        facilitiesAvailable: status.available,
        facilitiesRelevant: status.relevant,
        facilitiesUnknown: status.unknown,
        lastVerifiedAt: now,
        // Diterbitkan verifikator: label "langsung oleh admin" tidak berlaku lagi; terbit langsung memasangnya (ADR-0051).
        adminPublishedAt: direct ? now : null,
        adminPublishedBy: direct ? viewerId : null,
        updatedAt: now,
      };
      let before: Snapshot | null = null;
      if (place) {
        const current = await tx.select().from(placeFacilities).where(eq(placeFacilities.placeId, placeId));
        before = snapshot({ ...place, location: currentPoint! }, FACILITIES.map((facility) => {
          const f = current.find((c) => c.facility === facility);
          return { facility, answer: f?.answer ?? "belum_tahu", reason: f?.reason ?? null, note: f?.note ?? null };
        }));
        await tx.update(places).set(values).where(eq(places.id, placeId));
        await tx.delete(placeFacilities).where(eq(placeFacilities.placeId, placeId));
      } else {
        await tx.insert(places).values({ id: placeId, ...values, createdAt: now });
      }
      await tx.insert(placeFacilities).values(facilities.map((f) => ({ placeId, ...f, updatedAt: now })));

      for (const { photo, key, width, height, bytes } of published) {
        await tx
          .update(photos)
          .set({ placeId, storageKey: key, moderation: "tayang", altText: altText(photo.tag, name), width, height, bytes, blurRegions: null })
          .where(eq(photos.id, photo.id));
      }
      const privateKeys = published.map(({ photo }) => photo.storageKey);
      if (privateKeys.length) await tx.insert(photoDeletions).values(privateKeys.map((storageKey) => ({ storageKey }))).onConflictDoNothing();
      const hiddenKeys = await dropReportPhotos(tx, { ids: hidden.map((p) => p.id) });
      // Foto tempat yang dihapus admin: barisnya dibuang dan berkas publiknya diantrekan untuk dihapus.
      const removed = direct?.removePhotoIds?.length && place
        ? await tx.select({ id: photos.id, storageKey: photos.storageKey, tag: photos.tag }).from(photos).where(and(inArray(photos.id, direct.removePhotoIds), eq(photos.placeId, placeId), eq(photos.moderation, "tayang")))
        : [];
      const removedKeys = removed.length ? await dropReportPhotos(tx, { ids: removed.map((p) => p.id) }) : [];

      await tx
        .update(reports)
        .set({
          status: "diterbitkan",
          placeId,
          decidedAt: now,
          reviewerId: viewerId,
          ...(input.note !== undefined ? { reviewerNote: input.note } : {}),
          rejectionReason: null,
          clarificationQuestion: null,
          clarificationDueAt: null,
        })
        .where(eq(reports.id, id));

      const actor = { userId: viewerId };
      const after = snapshot({ ...values, location }, facilities);
      const why = direct ? { alasan: direct.reason, ...(direct.osm ? { osm: direct.osm } : {}) } : {};
      const placeAction = direct ? (place ? "diubah_admin" : "dibuat_admin") : place ? "diubah" : "dibuat";
      const entries: AuditEntry[] = [
        { entity: "lokasi", entityId: placeId, actor, action: placeAction, changes: { ...diff(before, after), laporan: id, ...why }, at: now },
        { entity: "laporan", entityId: id, actor, action: direct ? "terbit_langsung" : "diterbitkan", changes: { status: { sebelum: report.status, sesudah: "diterbitkan" }, lokasi: placeId, ...why }, at: now },
        ...removed.map((photo): AuditEntry => ({ entity: "foto", entityId: photo.id, actor, action: "dihapus", changes: { lokasi: placeId, tag: photo.tag, alasan: direct!.reason }, at: now })),
        ...published.map(({ photo }): AuditEntry => ({ entity: "foto", entityId: photo.id, actor, action: "diterbitkan", changes: { laporan: id, tag: photo.tag, areaKabur: photo.blurRegions?.length ?? 0 }, at: now })),
        ...hidden.map((photo): AuditEntry => ({ entity: "foto", entityId: photo.id, actor, action: "dihapus", changes: { laporan: id, disembunyikan: true }, at: now })),
      ];
      await audit(tx, ...entries);
      // Admin yang menerbitkan laporannya sendiri tidak perlu email "laporan Anda diterbitkan".
      if (!direct) await queueEmail(tx, id, "diterbitkan", now);
      return { placeId, status: status.status, removeKeys: [...privateKeys, ...hiddenKeys, ...removedKeys] };
    });
    await removeQueuedFiles(db, store, result.removeKeys, log);
    return { placeId: result.placeId, status: result.status };
  } catch (error) {
    if (copied.length > 0) {
      await db.insert(photoDeletions).values(copied.map((storageKey) => ({ storageKey }))).onConflictDoNothing();
      await removeQueuedFiles(db, store, copied, log);
    }
    throw error;
  }
}
