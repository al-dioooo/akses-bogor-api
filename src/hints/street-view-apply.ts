// Menerapkan satu manifest verifikasi Street View (ADR-0057) dalam satu transaksi. Data yang tidak terjawab:
// salinan petunjuk disembunyikan, tempat admin diturunkan (ADR-0051), dan kandidat OSM disembunyikan hanya bila diminta.
// Data yang terjawab ditangani `street-view-settle.ts`, dan `--batalkan` oleh `street-view-undo.ts`. Alat ini tidak
// pernah menulis tabel `reports`. Ada di modul petunjuk karena mengubah salinan tersimpan (ADR-0052).
import { eq, sql } from "drizzle-orm";
import { unpublishPlace } from "../admin/edit.js";
import type { Actor } from "../audit/log.js";
import type { Db } from "../db/client.js";
import { places } from "../db/schema.js";
import type { PhotoStore } from "../photos/storage.js";
import { inPublishTransaction } from "../verification/publish.js";
import { ManifestError, targetKey, type Manifest } from "./street-view-manifest.js";
import { hideCandidate, hideCopies, type Mark, type Tags } from "./street-view-tags.js";

export type ManifestRecord = Manifest["records"][number];
type Log = { warn: (obj: object, msg: string) => void };

/** Pelaku di log audit: skrip server, ditampilkan "Skrip server" di riwayat tempat. */
export const ACTOR: Actor = { label: "skrip" };

export type RunOptions = {
  now: Date;
  dryRun: boolean;
  /** Menyembunyikan kandidat OSM yang tidak terjawab; mati bawaan, karena pemilik produk belum memutuskannya. */
  hideCandidates: boolean;
  undo: boolean;
  store?: PhotoStore;
  log?: Log;
};

/** Galat satu data: dicatat, data lain tetap diperiksa, lalu seluruh transaksi dibatalkan. */
export class RecordError extends Error {}

export type Context = {
  tx: Db;
  round: string;
  opts: RunOptions;
  lines: string[];
  counts: Map<string, number>;
  /** Berkas publik yang sudah diunggah; dihapus lagi bila transaksi gagal. */
  copied: string[];
  /** Berkas yang dihapus setelah transaksi berhasil. */
  removeKeys: string[];
  say: (rec: ManifestRecord, line: string) => void;
  count: (key: string, n?: number) => void;
  mark: (rec: ManifestRecord) => Mark;
};

export type Handler = (ctx: Context, rec: ManifestRecord) => Promise<void>;

/** Alasan menurunkan tempat. Awalannya dipakai `--batalkan` untuk mengenali tindakan putaran dan data ini sendiri. */
export const unpublishPrefix = (round: string, recordId: string) => `Street View ${round}/${recordId}`;

const rowsOf = <T>(result: unknown) => (result as { rows: T[] }).rows;

export type OsmRow = { osm_type: string; osm_id: string | number; name: string | null; category: string; tags: Tags; lat: number; lng: number };

/** Baris kandidat OSM sasaran, dikunci sampai transaksi selesai. */
export async function lockOsm(tx: Db, rec: ManifestRecord): Promise<OsmRow> {
  if (rec.target.kind !== "osm") throw new Error("bukan sasaran OSM");
  const [row] = rowsOf<OsmRow>(
    await tx.execute(sql`
      SELECT osm_type, osm_id, name, category, tags, ST_Y(location) AS lat, ST_X(location) AS lng
      FROM osm_places WHERE osm_type = ${rec.target.osmType} AND osm_id = ${rec.target.osmId} FOR UPDATE`),
  );
  if (!row) throw new RecordError(`kandidat ${targetKey(rec.target)} tidak ada di osm_places`);
  return { ...row, tags: (typeof row.tags === "string" ? JSON.parse(row.tags) : row.tags) as Tags };
}

export async function writeTags(tx: Db, row: OsmRow, tags: Tags) {
  await tx.execute(sql`UPDATE osm_places SET tags = ${JSON.stringify(tags)}::jsonb WHERE osm_type = ${row.osm_type} AND osm_id = ${row.osm_id}`);
}

/** Tempat sasaran beserta asal datanya, dikunci sampai transaksi selesai. */
export async function lockPlace(tx: Db, placeId: string) {
  const [place] = await tx.select().from(places).where(eq(places.id, placeId)).for("update");
  return place ?? null;
}

/** Tempat dari laporan yang diperiksa verifikator: Street View tidak pernah mengubah atau menurunkannya. */
export const checkedByTeam = (place: { verificationSource: string; adminPublishedAt: Date | null }) => place.verificationSource === "laporan" && place.adminPublishedAt === null;

/** Data tidak terjawab: sembunyikan salinan dan (bila diminta) kandidatnya, atau turunkan tempat admin. */
export async function hideUnsettled(ctx: Context, rec: ManifestRecord) {
  const mark = ctx.mark(rec);
  if (rec.target.kind === "osm") {
    const row = await lockOsm(ctx.tx, rec);
    const copies = hideCopies(row.tags, mark);
    for (const key of copies.moved) ctx.say(rec, `sembunyikan salinan ${key}`);
    ctx.count("salinan_disembunyikan", copies.moved.length);
    let tags = copies.tags;
    if (ctx.opts.hideCandidates) {
      const candidate = hideCandidate(tags, mark);
      if (candidate.changed) {
        ctx.say(rec, "sembunyikan kandidat");
        ctx.count("kandidat_disembunyikan");
      }
      tags = candidate.tags;
    }
    if (tags === row.tags) ctx.say(rec, "lewati: tidak ada salinan yang belum diperiksa");
    else await writeTags(ctx.tx, row, tags);
    return;
  }
  const place = await lockPlace(ctx.tx, rec.target.placeId);
  if (!place) throw new RecordError(`tempat ${rec.target.placeId} tidak ada`);
  if (place.unpublishedAt) {
    ctx.say(rec, `lewati: "${place.name}" sudah diturunkan`);
    ctx.count("tempat_dilewati");
    return;
  }
  if (checkedByTeam(place)) throw new RecordError(`"${place.name}" diverifikasi lewat laporan; Street View tidak menurunkannya`);
  const reason = `${unpublishPrefix(ctx.round, rec.record)}: ${rec.reason}`.slice(0, 500);
  await unpublishPlace(ctx.tx, ACTOR, place.id, reason, ctx.opts.now);
  ctx.say(rec, `turunkan tempat "${place.name}" (${place.verificationSource === "street_view" ? "Street View" : "admin"})`);
  ctx.count("tempat_diturunkan");
}

/** Pengecualian untuk membatalkan transaksi dry run setelah semua perubahan dicetak. */
class DryRun extends Error {
  constructor(readonly result: RunResult) {
    super("dry run");
  }
}

export type RunResult = { lines: string[]; counts: Map<string, number> };

/**
 * Menjalankan setiap data manifest dengan `handler` di savepoint sendiri. Galat satu data dikumpulkan, dan bila ada,
 * seluruh transaksi dibatalkan dengan `ManifestError`. Dry run menjalankan jalur yang sama tanpa mengunggah foto, lalu
 * membatalkan transaksinya, jadi yang dicetak sama dengan yang akan terjadi.
 */
export async function runRecords(db: Db, manifest: Manifest, opts: RunOptions, handler: Handler): Promise<RunResult> {
  try {
    const result = await inPublishTransaction(db, opts.store, opts.log, async (tx, copied) => {
      const lines: string[] = [];
      const counts = new Map<string, number>();
      const errors: string[] = [];
      const ctx: Context = {
        tx,
        round: manifest.round,
        opts,
        lines,
        counts,
        copied,
        removeKeys: [],
        say: (rec, line) => lines.push(`data ${rec.record} ${targetKey(rec.target)}: ${line}`),
        count: (key, n = 1) => counts.set(key, (counts.get(key) ?? 0) + n),
        mark: (rec) => ({ round: manifest.round, record: rec.record, reason: rec.reason, at: opts.now.toISOString() }),
      };
      for (const rec of manifest.records) {
        try {
          await tx.transaction((sp) => handler({ ...ctx, tx: sp }, rec));
        } catch (error) {
          if (!(error instanceof RecordError)) throw error;
          errors.push(`data ${rec.record} ${targetKey(rec.target)}: ${error.message}`);
          lines.push(`data ${rec.record} ${targetKey(rec.target)}: galat: ${error.message}`);
        }
      }
      if (errors.length > 0) throw new ManifestError(errors);
      if (opts.dryRun) throw new DryRun({ lines, counts });
      return { lines, counts, removeKeys: ctx.removeKeys };
    });
    return { lines: result.lines, counts: result.counts };
  } catch (error) {
    if (error instanceof DryRun) return error.result;
    throw error;
  }
}
