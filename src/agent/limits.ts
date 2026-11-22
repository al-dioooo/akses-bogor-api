// Batas harian agen rute (ADR-0043, ADR-0047). Hitungannya di memori proses, seperti batas Mapbox Directions, jadi
// kembali ke nol saat hari berganti atau API di-restart. Batas dan saldo akun di penyedia model tetap menjadi pengaman
// terakhir.

/**
 * Bawaan `AGENT_REQUESTS_PER_DAY`: permintaan ke model yang berhasil untuk semua pengguna per hari UTC. Angka 45 berasal
 * dari kuota model gratis OpenRouter (di bawah 50 per hari tanpa kredit). Permintaan yang gagal mengembalikan jatahnya.
 */
export const DEFAULT_REQUESTS_PER_DAY = 45;
/** Pertanyaan per akun per hari WIB. */
export const QUESTIONS_PER_ACCOUNT_PER_DAY = 5;

export type DailyLimit = {
  /** Memakai satu jatah untuk `key`; `false` bila jatah hari ini sudah habis. */
  take(key?: string): boolean;
  /** Mengembalikan satu jatah, mis. bila agen ternyata sibuk. */
  give(key?: string): void;
};

/** Batas harian per kunci; `utcOffsetHours` menentukan kapan hari berganti (0 untuk UTC, 7 untuk WIB). */
export function dailyLimit(perDay: number, now: () => Date, utcOffsetHours: number): DailyLimit {
  let day = "";
  const used = new Map<string, number>();
  const sync = () => {
    const today = new Date(now().getTime() + utcOffsetHours * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      used.clear();
    }
  };
  return {
    take(key = "") {
      sync();
      const count = used.get(key) ?? 0;
      if (count >= perDay) return false;
      used.set(key, count + 1);
      return true;
    },
    give(key = "") {
      sync();
      const count = used.get(key) ?? 0;
      if (count > 0) used.set(key, count - 1);
    },
  };
}
