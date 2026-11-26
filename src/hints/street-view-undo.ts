// `--batalkan` untuk satu manifest verifikasi Street View (ADR-0057): mengembalikan hanya yang dibuat putaran dan data
// itu sendiri. Salinan dan kandidat kembali tampil, tempat admin yang diturunkan ditayangkan lagi, tempat yang diubah
// dipulihkan dari keadaan di log audit beserta fotonya dihapus, dan tempat yang dibuat diturunkan (tidak pernah dihapus
// permanen, ADR-0051). Tempat yang sudah berubah setelah diterapkan tidak disentuh.
import { eq } from "drizzle-orm";
import { restorePlace, unpublishPlace } from "../admin/edit.js";
import { audit, diff, type AuditEntry } from "../audit/log.js";
import { photos, placeFacilities, places } from "../db/schema.js";
import { computeStatus } from "../domain/status.js";
import { dropReportPhotos } from "../verification/decide.js";
import { ACTOR, lockOsm, lockPlace, RecordError, unpublishPrefix, writeTags, type Context, type ManifestRecord } from "./street-view-apply.js";
import { CREATED, fullState, lastEntry, snapshot, type FullState } from "./street-view-settle.js";
import { targetKey } from "./street-view-manifest.js";
import { restoreCopies, showCandidate, unmarkChecked } from "./street-view-tags.js";

export const UNDONE = "street_view_dibatalkan";

async function undoTags(ctx: Context, rec: ManifestRecord) {
  if (rec.target.kind !== "osm") return;
  const row = await lockOsm(ctx.tx, rec).catch((error: unknown) => {
    if (error instanceof RecordError) return null;
    throw error;
  });
  if (!row) return ctx.say(rec, "lewati: kandidat tidak ada lagi di osm_places");
  const copies = restoreCopies(row.tags, ctx.round, rec.record);
  const marks = unmarkChecked(copies.tags, ctx.round, rec.record);
  const candidate = showCandidate(marks.tags, ctx.round, rec.record);
  for (const key of copies.restored) ctx.say(rec, `kembalikan salinan ${key}`);
  for (const key of copies.kept) ctx.say(rec, `salinan ${key} yang disembunyikan tetap disimpan: kuncinya sudah berisi salinan baru`);
  for (const key of marks.unmarked) ctx.say(rec, `hapus tanda sudah diperiksa di ${key}`);
  if (candidate.changed) ctx.say(rec, "tampilkan lagi kandidat");
  ctx.count("salinan_dikembalikan", copies.restored.length);
  ctx.count("tanda_dihapus", marks.unmarked.length);
  ctx.count("kandidat_ditampilkan", candidate.changed ? 1 : 0);
  if (candidate.tags !== row.tags) await writeTags(ctx.tx, row, candidate.tags);
}

/** Memulihkan tempat ke keadaan sebelum diterapkan, dan menghapus foto Street View yang ditambahkan saat itu. */
async function restoreState(ctx: Context, rec: ManifestRecord, placeId: string, state: FullState, photoIds: string[], reason: string) {
  const { tx } = ctx;
  const place = (await lockPlace(tx, placeId))!;
  const current = fullState(place, await tx.select().from(placeFacilities).where(eq(placeFacilities.placeId, placeId)));
  const status = computeStatus(state.facilities);
  await tx
    .update(places)
    .set({
      name: state.name,
      category: state.category,
      districtSlug: state.districtSlug,
      location: { x: state.location.lng, y: state.location.lat },
      landmark: state.landmark,
      description: state.description,
      status: status.status,
      facilitiesAvailable: status.available,
      facilitiesRelevant: status.relevant,
      facilitiesUnknown: status.unknown,
      lastVerifiedAt: new Date(state.lastVerifiedAt),
      adminPublishedAt: state.adminPublishedAt ? new Date(state.adminPublishedAt) : null,
      adminPublishedBy: state.adminPublishedBy,
      verificationSource: state.verificationSource,
      streetViewImageDate: state.streetViewImageDate,
      unpublishedAt: state.unpublishedAt ? new Date(state.unpublishedAt) : null,
      unpublishedReason: state.unpublishedReason,
      updatedAt: ctx.opts.now,
    })
    .where(eq(places.id, placeId));
  await tx.delete(placeFacilities).where(eq(placeFacilities.placeId, placeId));
  await tx.insert(placeFacilities).values(state.facilities.map((f) => ({ placeId, ...f, updatedAt: ctx.opts.now })));
  const removed = photoIds.length ? await tx.select({ id: photos.id, tag: photos.tag }).from(photos).where(eq(photos.placeId, placeId)) : [];
  const ours = removed.filter((p) => photoIds.includes(p.id));
  ctx.removeKeys.push(...(await dropReportPhotos(tx, { ids: ours.map((p) => p.id) })));
  const changes = diff(snapshot({ ...current, status: place.status, published: place.unpublishedAt === null }), snapshot({ ...state, status: status.status, published: state.unpublishedAt === null }));
  const entries: AuditEntry[] = [
    { entity: "lokasi", entityId: placeId, actor: ACTOR, action: UNDONE, changes: { ...changes, alasan: reason, putaran: ctx.round, data: rec.record }, at: ctx.opts.now },
    ...ours.map((p): AuditEntry => ({ entity: "foto", entityId: p.id, actor: ACTOR, action: "dihapus", changes: { lokasi: placeId, tag: p.tag, alasan: reason }, at: ctx.opts.now })),
  ];
  await audit(tx, ...entries);
  ctx.say(rec, `pulihkan tempat "${state.name}" ke keadaan sebelum putaran ini; hapus ${ours.length} foto Street View`);
  ctx.count("tempat_dipulihkan");
  ctx.count("foto_dihapus", ours.length);
}

export async function undoRecord(ctx: Context, rec: ManifestRecord) {
  const reason = `${unpublishPrefix(ctx.round, rec.record)}: dibatalkan`;
  await undoTags(ctx, rec);

  if (rec.verdict === "unsettled") {
    if (rec.target.kind !== "place") return;
    const place = await lockPlace(ctx.tx, rec.target.placeId);
    if (!place?.unpublishedAt || !place.unpublishedReason?.startsWith(`${unpublishPrefix(ctx.round, rec.record)}:`)) {
      ctx.say(rec, "lewati: tempat ini tidak diturunkan putaran ini");
      return;
    }
    await restorePlace(ctx.tx, ACTOR, place.id, reason, ctx.opts.now);
    ctx.say(rec, `tayangkan lagi "${place.name}"`);
    ctx.count("tempat_ditayangkan_lagi");
    return;
  }

  const entry = await lastEntry(ctx.tx, targetKey(rec.target), { round: ctx.round, record: rec.record });
  if (!entry) {
    ctx.say(rec, "lewati: tidak ada tempat yang diterapkan putaran ini");
    return;
  }
  const place = await lockPlace(ctx.tx, entry.placeId);
  if (!place || place.updatedAt.getTime() > entry.at.getTime() || place.verificationSource !== "street_view") {
    ctx.say(rec, `lewati: "${place?.name ?? entry.placeId}" sudah berubah sejak diterapkan, tidak disentuh`);
    ctx.count("tempat_dilewati");
    return;
  }
  if (entry.action === CREATED) {
    if (place.unpublishedAt) return ctx.say(rec, `lewati: "${place.name}" sudah diturunkan`);
    await unpublishPlace(ctx.tx, ACTOR, place.id, reason, ctx.opts.now);
    ctx.say(rec, `turunkan tempat "${place.name}" yang dibuat putaran ini`);
    ctx.count("tempat_dibatalkan");
    return;
  }
  const before = entry.changes.sebelum as FullState | null;
  if (!before) throw new Error(`log audit ${entry.placeId} tanpa keadaan sebelumnya`);
  await restoreState(ctx, rec, place.id, before, Array.isArray(entry.changes.fotoBaru) ? (entry.changes.fotoBaru as string[]) : [], reason);
}
