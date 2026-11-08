// Pembersihan foto setiap jam (ADR-0031, ADR-0024): unggahan yang tidak dipasang ke laporan dalam 24 jam, lalu antrean
// `photo_deletions` dikosongkan dengan menghapus berkasnya dari R2 atau folder lokal.
import { and, asc, eq, inArray, isNull, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { photoDeletions, photos } from "../db/schema.js";
import type { PhotoStore } from "./storage.js";

const HOUR_MS = 60 * 60 * 1000;
/** Unggahan yang tidak jadi dipasang ke laporan dihapus setelah ini. */
export const UNATTACHED_PHOTO_HOURS = 24;
/** Berkas yang dihapus per putaran, supaya satu putaran tidak berjalan terlalu lama. */
const BATCH = 500;

type Log = { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };

/** Memindahkan unggahan lama yang belum terpasang ke antrean hapus, lalu menghapus berkas di antrean. */
export async function cleanUpPhotos(db: Db, store: PhotoStore | undefined, now: Date, log?: Log) {
  const before = new Date(now.getTime() - UNATTACHED_PHOTO_HOURS * HOUR_MS);
  const expired = await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: photos.id, storageKey: photos.storageKey })
      .from(photos)
      .where(and(isNull(photos.reportId), lt(photos.createdAt, before)));
    if (rows.length === 0) return 0;
    await tx
      .insert(photoDeletions)
      .values(rows.map(({ storageKey }) => ({ storageKey })))
      .onConflictDoNothing();
    await tx.delete(photos).where(
      inArray(
        photos.id,
        rows.map(({ id }) => id),
      ),
    );
    return rows.length;
  });

  // Tanpa penyimpanan (production tanpa R2), antrean tetap disimpan sampai R2 diatur.
  let removed = 0;
  let failed = 0;
  if (store) {
    const queue = await db.select({ storageKey: photoDeletions.storageKey }).from(photoDeletions).orderBy(asc(photoDeletions.requestedAt)).limit(BATCH);
    for (const { storageKey } of queue) {
      try {
        await store.remove(storageKey);
        await db.delete(photoDeletions).where(eq(photoDeletions.storageKey, storageKey));
        removed += 1;
      } catch (error) {
        // Dicoba lagi di putaran berikutnya.
        failed += 1;
        log?.warn({ err: error, storageKey }, "berkas foto gagal dihapus");
      }
    }
  }
  return { expired, removed, failed };
}

/** Menjalankan pembersihan foto saat server mulai lalu setiap jam. Mengembalikan fungsi untuk menghentikannya. */
export function schedulePhotoCleanup(db: Db, store: PhotoStore | undefined, now: () => Date, log: Log) {
  const run = async () => {
    try {
      const result = await cleanUpPhotos(db, store, now(), log);
      if (result.expired + result.removed + result.failed > 0) log.info(result, "pembersihan foto");
    } catch (error) {
      log.warn({ err: error }, "pembersihan foto gagal");
    }
  };
  void run();
  const timer = setInterval(() => void run(), HOUR_MS);
  timer.unref();
  return () => clearInterval(timer);
}
