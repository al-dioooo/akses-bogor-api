// Data Street View yang terjawab (ADR-0057): tempat dibuat dari kandidat OSM atau diperbarui, jawaban fasilitas persis
// seperti penilaian, gambar dipasang sebagai foto lewat penyimpanan foto yang sama (WebP, bucket publik R2), sumbernya
// `street_view`, dan salinan petunjuk kandidat ditandai sudah diperiksa. Tempat yang diverifikasi lewat laporan tidak
// diubah. Log audit menyimpan keadaan sebelumnya, supaya `--batalkan` bisa memulihkannya.
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { audit, diff, type AuditEntry } from "../audit/log.js";
import type { Db } from "../db/client.js";
import { placeFacilities, photos, places } from "../db/schema.js";
import { computeStatus, FACILITIES } from "../domain/status.js";
import { processPhoto, type ProcessedPhoto } from "../photos/process.js";
import { districtAt } from "../reports/location.js";
import { SAME_PLACE_METERS } from "../contribute/facilities.js";
import { ACTOR, checkedByTeam, lockOsm, lockPlace, RecordError, writeTags, type Context, type ManifestRecord, type OsmRow } from "./street-view-apply.js";
import { photoAlt, photoCaption, targetKey, type FinalAnswer, type Manifest } from "./street-view-manifest.js";
import { markChecked } from "./street-view-tags.js";

/** Foto tayang paling banyak per tempat (ADR-0023). */
const MAX_PLACE_PHOTOS = 10;
export const CREATED = "dibuat_street_view";
export const UPDATED = "diubah_street_view";

type Settled = Extract<ManifestRecord, { verdict: "settled" }>;
export type PreparedImage = ProcessedPhoto & { sha256: string };
type Place = NonNullable<Awaited<ReturnType<typeof lockPlace>>>;

/** Membaca dan memproses semua gambar sebelum transaksi dibuka. Berkas harus ada di dalam folder manifest. */
export async function prepareImages(manifest: Manifest, dir: string) {
  const images = new Map<string, PreparedImage>();
  const problems: string[] = [];
  const root = resolve(dir);
  for (const rec of manifest.records) {
    if (rec.verdict !== "settled") continue;
    for (const p of rec.photos) {
      const path = resolve(root, p.file);
      if (!path.startsWith(root + sep)) {
        problems.push(`data ${rec.record}: ${p.file} ada di luar folder manifest`);
        continue;
      }
      try {
        const raw = await readFile(path);
        images.set(p.file, { ...(await processPhoto(raw)), sha256: createHash("sha256").update(raw).digest("hex") });
      } catch (error) {
        problems.push(`data ${rec.record}: ${p.file} tidak bisa dipakai (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  }
  return { images, problems };
}

/** Id foto tetap untuk gambar yang sama di sasaran yang sama, jadi menjalankan ulang tidak menggandakan foto (UUID v8). */
export function photoIdFor(target: string, sha256: string) {
  const h = createHash("sha256").update(`${target}|${sha256}`).digest("hex");
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Entri log audit Street View terakhir untuk sasaran ini, bisa dibatasi ke satu putaran dan nomor data. */
export async function lastEntry(tx: Db, target: string, only?: { round: string; record: string }) {
  const result = await tx.execute(sql`
    SELECT entity_id, action, changes, created_at FROM audit_log
    WHERE entity_type = 'lokasi' AND action IN (${CREATED}, ${UPDATED}) AND changes->>'sasaran' = ${target}
      ${only ? sql`AND changes->>'putaran' = ${only.round} AND changes->>'data' = ${only.record}` : sql``}
    ORDER BY id DESC LIMIT 1`);
  const [row] = (result as unknown as { rows: { entity_id: string; action: string; changes: Record<string, unknown>; created_at: Date | string }[] }).rows;
  return row ? { placeId: row.entity_id, action: row.action, changes: row.changes, at: new Date(row.created_at) } : null;
}

/** Tempat tayang berkategori sama dalam 50 m dari pintu masuk atau titik kandidat, terdekat dulu. */
async function nearbyPlace(tx: Db, category: string, entrance: { lat: number; lng: number }, osm: OsmRow) {
  const at = (p: { lat: number; lng: number }) => sql`ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326)::geography`;
  const result = await tx.execute(sql`
    SELECT id FROM places WHERE category = ${category} AND unpublished_at IS NULL
      AND (ST_DWithin(location::geography, ${at(entrance)}, ${SAME_PLACE_METERS}) OR ST_DWithin(location::geography, ${at({ lat: Number(osm.lat), lng: Number(osm.lng) })}, ${SAME_PLACE_METERS}))
    ORDER BY ST_Distance(location::geography, ${at(entrance)}) LIMIT 1`);
  const [row] = (result as unknown as { rows: { id: string }[] }).rows;
  return row ? lockPlace(tx, row.id) : null;
}

type Answers = Pick<FinalAnswer, "facility" | "answer" | "reason" | "note">[];
const answersOf = (tx: Db, placeId: string): Promise<Answers> =>
  tx.select({ facility: placeFacilities.facility, answer: placeFacilities.answer, reason: placeFacilities.reason, note: placeFacilities.note }).from(placeFacilities).where(eq(placeFacilities.placeId, placeId));

const round7 = (n: number) => Math.round(n * 1e7) / 1e7;

/** Keadaan lengkap tempat untuk dipulihkan `--batalkan`. */
export function fullState(place: Place, answers: Answers) {
  return {
    name: place.name,
    category: place.category,
    districtSlug: place.districtSlug,
    location: { lat: place.location.y, lng: place.location.x },
    landmark: place.landmark,
    description: place.description,
    lastVerifiedAt: place.lastVerifiedAt.toISOString(),
    adminPublishedAt: place.adminPublishedAt?.toISOString() ?? null,
    adminPublishedBy: place.adminPublishedBy,
    verificationSource: place.verificationSource,
    streetViewImageDate: place.streetViewImageDate,
    unpublishedAt: place.unpublishedAt?.toISOString() ?? null,
    unpublishedReason: place.unpublishedReason,
    facilities: FACILITIES.map((facility) => answers.find((a) => a.facility === facility) ?? { facility, answer: "belum_tahu", reason: null, note: null }),
  };
}
export type FullState = ReturnType<typeof fullState>;

/** Bentuk yang dibandingkan dan dicatat sebagai "yang berubah", dengan kunci yang sama seperti terbit lewat laporan. */
export const snapshot = (s: Omit<FullState, "lastVerifiedAt" | "adminPublishedAt" | "adminPublishedBy" | "unpublishedAt" | "unpublishedReason"> & { status: string; published: boolean }) => ({
  name: s.name,
  category: s.category,
  district: s.districtSlug,
  location: { lat: round7(s.location.lat), lng: round7(s.location.lng) },
  landmark: s.landmark,
  description: s.description,
  status: s.status,
  facilities: Object.fromEntries(s.facilities.map((f) => [f.facility, { answer: f.answer, reason: f.reason, note: f.note }])),
  sumber: s.verificationSource,
  gambar: s.streetViewImageDate,
  tayang: s.published,
});

const describe = (answers: Answers) => answers.map((a) => `${a.facility}=${a.answer}${a.reason ? ` (${a.reason})` : ""}`).join(", ");

/** Data terjawab: buat atau perbarui tempatnya, pasang fotonya, dan tandai salinan kandidatnya. */
export async function settle(ctx: Context, rec: Settled, images: Map<string, PreparedImage>) {
  const { tx } = ctx;
  const key = targetKey(rec.target);
  const osm = rec.target.kind === "osm" ? await lockOsm(tx, rec) : null;
  if (osm && osm.category !== rec.place.category) throw new RecordError(`kategori ${rec.place.category} tidak sama dengan kandidat (${osm.category})`);

  const previous = await lastEntry(tx, key);
  let place: Place | null;
  if (rec.target.kind === "place") {
    place = await lockPlace(tx, rec.target.placeId);
    if (!place) throw new RecordError(`tempat ${rec.target.placeId} tidak ada`);
    if (place.category !== rec.place.category) throw new RecordError(`kategori ${rec.place.category} tidak sama dengan tempat (${place.category})`);
  } else {
    place = previous ? await lockPlace(tx, previous.placeId) : await nearbyPlace(tx, rec.place.category, rec.place.entrance, osm!);
  }

  const markCopies = async (placeId: string) => {
    if (!osm) return;
    const marked = markChecked(osm.tags, { ...ctx.mark(rec), placeId, imageMonth: rec.imageMonth });
    for (const tag of marked.marked) ctx.say(rec, `tandai salinan ${tag} sudah diperiksa`);
    ctx.count("salinan_ditandai", marked.marked.length);
    if (marked.marked.length > 0) await writeTags(tx, osm, marked.tags);
  };

  if (place && checkedByTeam(place)) {
    ctx.say(rec, `lewati: "${place.name}" sudah diverifikasi lewat laporan, tidak diubah`);
    ctx.count("tempat_dilewati");
    return markCopies(place.id);
  }
  if (place?.unpublishedAt && !place.unpublishedReason?.startsWith("Street View ")) {
    throw new RecordError(`"${place.name}" diturunkan admin; tayangkan dulu dari Kelola tempat atau keluarkan data ini`);
  }

  const district = await districtAt(tx, rec.place.entrance);
  if (!district) throw new RecordError("titik pintu masuk di luar Kota Bogor");
  const status = computeStatus(rec.facilities);
  const imageDate = `${rec.imageMonth}-01`;
  const planned = rec.photos.map((p) => {
    const image = images.get(p.file);
    if (!image) throw new RecordError(`${p.file} belum diproses`);
    return { p, image, id: photoIdFor(key, image.sha256) };
  });
  const existing = place ? await tx.select({ id: photos.id }).from(photos).where(and(eq(photos.placeId, place.id), eq(photos.moderation, "tayang"))) : [];
  const fresh = planned.filter((x) => !existing.some((e) => e.id === x.id));

  const beforeState = place ? fullState(place, await answersOf(tx, place.id)) : null;
  const landmark = rec.place.landmark ?? place?.landmark ?? null;
  const description = place?.description ?? null;
  const after = snapshot({ name: rec.place.name, category: rec.place.category, districtSlug: district.slug, location: rec.place.entrance, landmark, description, status: status.status, facilities: rec.facilities, verificationSource: "street_view", streetViewImageDate: imageDate, published: true });
  const before = beforeState && place ? snapshot({ ...beforeState, status: place.status, published: place.unpublishedAt === null }) : null;
  const changes = diff(before, after);
  if (place && Object.keys(changes).length === 0 && fresh.length === 0 && place.adminPublishedAt === null) {
    ctx.say(rec, `lewati: "${place.name}" sudah diterapkan, tidak ada perubahan`);
    ctx.count("tempat_dilewati");
    return markCopies(place.id);
  }
  if (existing.length + fresh.length > MAX_PLACE_PHOTOS) throw new RecordError(`tempat ini akan punya lebih dari ${MAX_PLACE_PHOTOS} foto`);
  if (fresh.length > 0 && !ctx.opts.dryRun && !ctx.opts.store) throw new RecordError("penyimpanan foto belum diatur (R2_* atau PHOTO_STORAGE_DIR)");

  const placeId = place?.id ?? randomUUID();
  const now = ctx.opts.now;
  const values = {
    name: rec.place.name,
    category: rec.place.category,
    districtSlug: district.slug,
    location: { x: rec.place.entrance.lng, y: rec.place.entrance.lat },
    landmark,
    description,
    status: status.status,
    facilitiesAvailable: status.available,
    facilitiesRelevant: status.relevant,
    facilitiesUnknown: status.unknown,
    // Tanggal verifikasi mengikuti bulan gambar, jadi "Perlu dicek ulang" muncul 12 bulan setelah gambar dibuat.
    lastVerifiedAt: new Date(`${imageDate}T00:00:00Z`),
    adminPublishedAt: null,
    adminPublishedBy: null,
    verificationSource: "street_view" as const,
    streetViewImageDate: imageDate,
    unpublishedAt: null,
    unpublishedReason: null,
    updatedAt: now,
  };
  if (place) {
    await tx.update(places).set(values).where(eq(places.id, placeId));
    await tx.delete(placeFacilities).where(eq(placeFacilities.placeId, placeId));
  } else {
    await tx.insert(places).values({ id: placeId, ...values, createdAt: now });
  }
  await tx.insert(placeFacilities).values(rec.facilities.map((f) => ({ placeId, ...f, updatedAt: now })));
  ctx.say(rec, `${place ? "ubah" : "buat"} tempat "${rec.place.name}" (${rec.place.category}, ${district.name}): ${status.status}; ${describe(rec.facilities)}; gambar ${rec.imageMonth}`);
  ctx.count(place ? "tempat_diubah" : "tempat_dibuat");

  for (const { p, image, id } of fresh) {
    const storageKey = `lokasi/${placeId}/${id}.webp`;
    if (!ctx.opts.dryRun) {
      await ctx.opts.store!.put(storageKey, image.data, "image/webp");
      ctx.copied.push(storageKey);
    }
    await tx.insert(photos).values({ id, placeId, source: "street_view", storageKey, tag: p.tag, altText: photoAlt(p, rec.place.name), caption: photoCaption(p), width: image.width, height: image.height, bytes: image.bytes, moderation: "tayang", createdAt: now });
    ctx.say(rec, `${ctx.opts.dryRun ? "akan unggah" : "unggah"} foto ${p.file} (${p.tag}, ${p.kind}, gambar ${p.image_date})`);
  }
  ctx.count("foto_diunggah", fresh.length);

  const mark = { putaran: ctx.round, data: rec.record, sasaran: key, gambar: rec.imageMonth };
  const entries: AuditEntry[] = [
    { entity: "lokasi", entityId: placeId, actor: ACTOR, action: place ? UPDATED : CREATED, changes: { ...changes, alasan: rec.reason, ...mark, fotoBaru: fresh.map((x) => x.id), sebelum: beforeState }, at: now },
    ...fresh.map(({ p, id }): AuditEntry => ({ entity: "foto", entityId: id, actor: ACTOR, action: "ditambah_street_view", changes: { lokasi: placeId, tag: p.tag, pano: p.pano_id, ...mark }, at: now })),
  ];
  await audit(tx, ...entries);
  await markCopies(placeId);
}
