// Aturan status "pintu masuk dulu" dan ringkasan "X dari Y fasilitas" (ADR-0018). Hanya jawaban yang sudah
// diverifikasi yang dihitung; alasan Tidak tersedia ikut dibawa untuk kalimat alasan (ADR-0022).
import type { facilityAnswer, facilityKind, placeStatus, unavailableReason } from "../db/schema.js";

export type Facility = (typeof facilityKind.enumValues)[number];
export type Answer = (typeof facilityAnswer.enumValues)[number];
export type Reason = (typeof unavailableReason.enumValues)[number];
export type Status = (typeof placeStatus.enumValues)[number];

/** Urutan tampil dan urutan pemeriksaan; ramp mewakili pintu masuk. */
export const FACILITIES = ["ramp", "toilet_difabel", "guiding_block", "lift"] as const satisfies readonly Facility[];

export interface FacilityAnswer {
  facility: Facility;
  answer: Answer;
  reason?: Reason | null;
}

export interface StatusResult {
  status: Status;
  /** Fasilitas relevan yang Tersedia (X). */
  available: number;
  /** Fasilitas selain Tidak perlu (Y). */
  relevant: number;
  /** Fasilitas relevan yang Belum tahu. */
  unknown: number;
  /** Fasilitas yang menentukan status, untuk kalimat alasan di Detail. Kosong bila Aksesibel. */
  because: FacilityAnswer[];
}

const pick = ({ facility, answer, reason }: FacilityAnswer): FacilityAnswer => ({ facility, answer, reason: reason ?? null });

export function computeStatus(input: readonly FacilityAnswer[]): StatusResult {
  // Fasilitas tanpa jawaban dihitung Belum tahu.
  const answers = FACILITIES.map((facility) => pick(input.find((a) => a.facility === facility) ?? { facility, answer: "belum_tahu" }));
  const relevant = answers.filter((a) => a.answer !== "tidak_perlu");
  const unavailable = relevant.filter((a) => a.answer === "tidak_tersedia");
  const unknown = relevant.filter((a) => a.answer === "belum_tahu");
  const ramp = answers[0]!;
  const counts = { available: relevant.filter((a) => a.answer === "tersedia").length, relevant: relevant.length, unknown: unknown.length };

  // 1. Pintu masuk tidak bisa dilewati: fasilitas lain tidak membantu.
  if (ramp.answer === "tidak_tersedia") return { status: "tidak_aksesibel", ...counts, because: [ramp] };
  // 2. Pintu masuk belum diketahui, atau setidaknya separuh fasilitas relevan belum diketahui.
  //    Tanpa fasilitas relevan sama sekali (semua Tidak perlu) aturan separuh tidak berlaku.
  if (ramp.answer === "belum_tahu" || (relevant.length > 0 && unknown.length * 2 >= relevant.length)) {
    return { status: "belum_diketahui", ...counts, because: unknown };
  }
  // 3. Semua fasilitas relevan tersedia.
  if (unavailable.length === 0 && unknown.length === 0) return { status: "aksesibel", ...counts, because: [] };
  // 4. Selain itu: sebagian, dengan yang tidak tersedia disebut lebih dulu.
  return { status: "sebagian", ...counts, because: [...unavailable, ...unknown] };
}
