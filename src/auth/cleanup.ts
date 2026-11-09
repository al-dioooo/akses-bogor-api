import { and, isNull, lt, notExists, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { reports, sessions, users, verifications } from "../db/schema.js";
import { INCOMPLETE_ACCOUNT_HOURS, SESSION_MAX_DAYS } from "./rules.js";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Pembersihan berkala (ADR-0029): akun yang tidak dilengkapi dalam 24 jam, sesi yang kedaluwarsa atau lebih dari 90
 * hari, dan kode email kedaluwarsa. Akun yang punya laporan tidak pernah dihapus di sini.
 */
export async function cleanUpAccounts(db: Db, now: Date) {
  const incompleteBefore = new Date(now.getTime() - INCOMPLETE_ACCOUNT_HOURS * HOUR_MS);
  const sessionsBefore = new Date(now.getTime() - SESSION_MAX_DAYS * 24 * HOUR_MS);
  const [removedUsers, removedSessions, removedCodes] = [
    await db
      .delete(users)
      .where(
        and(
          isNull(users.privacyConsentAt),
          lt(users.createdAt, incompleteBefore),
          notExists(db.select({ one: sql`1` }).from(reports).where(sql`${reports.reporterId} = ${users.id}`)),
        ),
      )
      .returning({ id: users.id }),
    await db
      .delete(sessions)
      .where(or(lt(sessions.expiresAt, now), lt(sessions.createdAt, sessionsBefore)))
      .returning({ id: sessions.id }),
    await db.delete(verifications).where(lt(verifications.expiresAt, now)).returning({ id: verifications.id }),
  ];
  return { users: removedUsers.length, sessions: removedSessions.length, codes: removedCodes.length };
}

/** Menjalankan pembersihan saat server mulai lalu setiap jam. Mengembalikan fungsi untuk menghentikannya. */
export function scheduleCleanup(db: Db, now: () => Date, log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void }) {
  const run = async () => {
    try {
      const removed = await cleanUpAccounts(db, now());
      if (removed.users + removed.sessions + removed.codes > 0) log.info(removed, "pembersihan akun");
    } catch (error) {
      log.warn({ err: error }, "pembersihan akun gagal");
    }
  };
  void run();
  const timer = setInterval(() => void run(), HOUR_MS);
  timer.unref();
  return () => clearInterval(timer);
}
