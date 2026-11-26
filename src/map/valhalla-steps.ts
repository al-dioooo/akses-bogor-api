// Kalimat langkah rute dalam bahasa Indonesia dari manuver Valhalla (ADR-0055). Valhalla 3.9 tidak punya narasi
// bahasa Indonesia, jadi kalimatnya dibuat di sini dari jenis manuver, nama jalan, dan arah.
import type { RouterManeuver } from "./valhalla.js";

export type AccessibleStep = {
  instruction: string;
  distanceMeters: number;
  durationSeconds: number;
  name: string | null;
  /** Jenis manuver ringkas: depart, arrive, turn, continue, roundabout, elevator, steps, building, other. */
  maneuver: string;
  location: { lat: number; lng: number };
};

const ARAH = ["utara", "timur laut", "timur", "tenggara", "selatan", "barat daya", "barat", "barat laut"];

/** Arah mata angin dari sudut 0 sampai 359 derajat. */
export const cardinal = (bearing: number) => ARAH[Math.round((((bearing % 360) + 360) % 360) / 45) % 8]!;

/** Nama jalan pertama yang bukan nomor rute, mis. "Jalan Pajajaran" dari ["2", "11", "Jalan Pajajaran"]. */
const streetName = (names: string[]) => names.find((name) => !/^\d+[A-Z]?$/.test(name.trim())) ?? null;

type Kind = { maneuver: string; text: (to: string, name: string | null) => string };
const turn = (text: string): Kind => ({ maneuver: "turn", text: (to) => `${text}${to}` });

/** Jenis manuver Valhalla (DirectionsLeg.Maneuver.Type) ke kalimat. `to` berisi " ke <nama jalan>" atau kosong. */
const KINDS: Record<number, Kind> = {
  4: { maneuver: "arrive", text: () => "Tiba di tujuan" },
  5: { maneuver: "arrive", text: () => "Tiba di tujuan, di sebelah kanan" },
  6: { maneuver: "arrive", text: () => "Tiba di tujuan, di sebelah kiri" },
  7: { maneuver: "continue", text: (to) => `Lanjut${to}` },
  8: { maneuver: "continue", text: (_to, name) => (name ? `Jalan terus di ${name}` : "Jalan terus") },
  9: turn("Belok sedikit ke kanan"),
  10: turn("Belok kanan"),
  11: turn("Belok tajam ke kanan"),
  12: turn("Putar balik ke kanan"),
  13: turn("Putar balik ke kiri"),
  14: turn("Belok tajam ke kiri"),
  15: turn("Belok kiri"),
  16: turn("Belok sedikit ke kiri"),
  17: { maneuver: "continue", text: (to) => `Jalan lurus${to}` },
  18: turn("Ambil jalur kanan"),
  19: turn("Ambil jalur kiri"),
  20: turn("Ambil jalur kanan"),
  21: turn("Ambil jalur kiri"),
  22: { maneuver: "continue", text: (_to, name) => (name ? `Tetap lurus di ${name}` : "Tetap lurus") },
  23: { maneuver: "continue", text: (to) => `Tetap di sisi kanan${to}` },
  24: { maneuver: "continue", text: (to) => `Tetap di sisi kiri${to}` },
  25: { maneuver: "continue", text: (to) => `Bergabung${to}` },
  26: { maneuver: "roundabout", text: () => "Masuk bundaran" },
  27: { maneuver: "roundabout", text: (to) => `Keluar dari bundaran${to}` },
  37: { maneuver: "continue", text: (to) => `Bergabung di kanan${to}` },
  38: { maneuver: "continue", text: (to) => `Bergabung di kiri${to}` },
  39: { maneuver: "elevator", text: () => "Naik atau turun lift" },
  40: { maneuver: "steps", text: () => "Lewati tangga" },
  41: { maneuver: "steps", text: () => "Naik atau turun eskalator" },
  42: { maneuver: "building", text: () => "Masuk ke gedung" },
  43: { maneuver: "building", text: () => "Keluar dari gedung" },
};

export function stepFrom(m: RouterManeuver): AccessibleStep {
  const name = streetName(m.streetNames);
  const to = name ? ` ke ${name}` : "";
  let maneuver = "other";
  let instruction: string;
  if (m.type >= 1 && m.type <= 3) {
    maneuver = "depart";
    const arah = m.bearing === null ? "" : ` ke arah ${cardinal(m.bearing)}`;
    instruction = `Mulai berjalan${arah}${name ? ` di ${name}` : ""}`;
  } else if (KINDS[m.type]) {
    maneuver = KINDS[m.type]!.maneuver;
    instruction = KINDS[m.type]!.text(to, name);
  } else {
    instruction = `Lanjut${to}`;
  }
  return { instruction, distanceMeters: m.distanceMeters, durationSeconds: m.durationSeconds, name, maneuver, location: m.location };
}
