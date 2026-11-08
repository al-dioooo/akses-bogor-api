// Menerbitkan laporan (FR-27, FR-32, FR-33, ADR-0036, ADR-0037). Satu transaksi mengunci laporan dan lokasinya, menyalin
// foto yang lolos moderasi ke bucket publik (dengan area kabur), lalu membuat atau memperbarui lokasi yang sama. Laporan
// perubahan dan kekurangan tidak pernah membuat lokasi kedua.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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

export async function publishReport(db: Db, store: PhotoStore | undefined, viewerId: string, id: string, input: PublishInput, now: Date, log?: Log) {
  // Berkas publik yang sudah disalin; dihapus lagi bila transaksi gagal.
  const copied: string[] = [];
  try {
    const result = await db.transaction(async (tx) => {
      const report = await lockReport(tx, id, viewerId);
      const facilities = finalAnswers(input.facilities);

      const [place] = report.placeId
        ? await tx
            .select({ id: places.id, updatedAt: places.updatedAt, name: places.name, category: places.category, districtSlug: places.districtSlug, location: places.location, landmark: places.landmark, description: places.description, status: places.status })
            .from(places)
            .where(eq(places.id, report.placeId))
            .for("update")
        : [];
      if (report.kind !== "baru") {
        if (!place) throw new HttpError(409, "lokasi_tidak_ada", "Lokasi yang dilaporkan sudah tidak ada. Tolak laporan ini.");
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
      const entries: AuditEntry[] = [
        { entity: "lokasi", entityId: placeId, actor, action: place ? "diubah" : "dibuat", changes: { ...diff(before, after), laporan: id }, at: now },
        { entity: "laporan", entityId: id, actor, action: "diterbitkan", changes: { status: { sebelum: report.status, sesudah: "diterbitkan" }, lokasi: placeId }, at: now },
        ...published.map(({ photo }): AuditEntry => ({ entity: "foto", entityId: photo.id, actor, action: "diterbitkan", changes: { laporan: id, tag: photo.tag, areaKabur: photo.blurRegions?.length ?? 0 }, at: now })),
        ...hidden.map((photo): AuditEntry => ({ entity: "foto", entityId: photo.id, actor, action: "dihapus", changes: { laporan: id, disembunyikan: true }, at: now })),
      ];
      await audit(tx, ...entries);
      await queueEmail(tx, id, "diterbitkan", now);
      return { placeId, status: status.status, removeKeys: [...privateKeys, ...hiddenKeys] };
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
