// Ringkasan tag jalur OSM (jalur.json) dari pembangunan ubin Valhalla (ADR-0055, deploy/valhalla/jalur.py). Valhalla
// tidak membedakan tag yang kosong dari tag bernilai "tidak", jadi cakupan data rute dihitung dari berkas ini.
import { readFile, stat } from "node:fs/promises";

/** Bendera per way, sama dengan deploy/valhalla/jalur.py. */
export const WAY = {
  /** Jalur pejalan kaki sendiri, atau jalan dengan tag sidewalk* (termasuk "no" dan "separate"). */
  sidewalkKnown: 1,
  /** Ada tag surface. */
  surfaceKnown: 2,
  /** Jalur penyeberangan. */
  crossing: 4,
  /** Jalur ini atau salah satu node-nya punya tag kerb. */
  kerbKnown: 8,
  /** Jalan yang dicatat tanpa trotoar. */
  noSidewalk: 16,
  /** Permukaan tidak rata atau tanah, atau smoothness buruk. */
  roughSurface: 32,
  /** incline lebih dari 8 persen. */
  steep: 64,
  /** Ada node kerb=raised. */
  raisedKerb: 128,
  /** highway=steps. */
  steps: 256,
} as const;

export type WayFlags = {
  flagsOf: (wayId: number) => number;
  /** Tanggal ekstrak OSM, mis. "2026-11-25", bila tercatat. */
  dataDate: string | null;
};

/** Pembaca jalur.json; `null` bila berkasnya belum ada atau rusak, dan cakupan dilaporkan tidak diketahui. */
export type WayFlagsSource = () => Promise<WayFlags | null>;

type File = { versi?: number; sumber?: string; jalur?: Record<string, number> };

export function parseWayFlags(text: string): WayFlags {
  const body = JSON.parse(text) as File;
  if (body.versi !== 1 || typeof body.jalur !== "object" || body.jalur === null) throw new Error("jalur.json tidak dikenal");
  const flags = new Map<number, number>();
  for (const [id, value] of Object.entries(body.jalur)) if (Number.isInteger(value)) flags.set(Number(id), value);
  const date = /\d{4}-\d{2}-\d{2}/.exec(body.sumber ?? "")?.[0] ?? null;
  return { flagsOf: (wayId) => flags.get(wayId) ?? 0, dataDate: date };
}

/**
 * Membaca jalur.json saat pertama dipakai, lalu membaca ulang bila waktu ubahnya berganti (tautan aktif dipindah setelah
 * ubin dibangun ulang). Pemeriksaan berkas paling sering sekali per `checkEveryMs`.
 */
export function wayFlagsFile(path: string, { now = Date.now, checkEveryMs = 60_000 }: { now?: () => number; checkEveryMs?: number } = {}): WayFlagsSource {
  let loaded: { mtimeMs: number; flags: WayFlags | null } | null = null;
  let checkedAt = -Infinity;
  return async () => {
    if (loaded && now() - checkedAt < checkEveryMs) return loaded.flags;
    checkedAt = now();
    try {
      const { mtimeMs } = await stat(path);
      if (loaded?.mtimeMs !== mtimeMs) loaded = { mtimeMs, flags: parseWayFlags(await readFile(path, "utf8")) };
    } catch {
      loaded = { mtimeMs: -1, flags: null };
    }
    return loaded.flags;
  };
}
