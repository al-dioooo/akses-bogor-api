import { describe, expect, it } from "vitest";
import { computeStatus, type Answer, type FacilityAnswer, type Reason } from "../src/domain/status.js";

// Shorthand: [ramp, toilet_difabel, guiding_block, lift]
const T = "tersedia", X = "tidak_tersedia", N = "tidak_perlu", U = "belum_tahu";
const facilities = (answers: [Answer, Answer, Answer, Answer], reasons: Partial<Record<number, Reason>> = {}): FacilityAnswer[] =>
  (["ramp", "toilet_difabel", "guiding_block", "lift"] as const).map((facility, i) => ({ facility, answer: answers[i]!, reason: reasons[i] ?? null }));

describe("computeStatus (ADR-0018)", () => {
  it("gives Sebagian with the unavailable facility as the reason, like the Halte contoh design", () => {
    const r = computeStatus(facilities([T, N, X, T], { 2: "tidak_sesuai" }));
    expect(r).toEqual({
      status: "sebagian", available: 2, relevant: 3, unknown: 0,
      because: [{ facility: "guiding_block", answer: X, reason: "tidak_sesuai" }],
    });
  });

  it("gives Aksesibel when every relevant facility is available", () => {
    expect(computeStatus(facilities([T, T, T, T]))).toMatchObject({ status: "aksesibel", available: 4, relevant: 4, because: [] });
  });

  it("does not count Tidak perlu, e.g. a flat entrance needs no ramp", () => {
    expect(computeStatus(facilities([N, T, T, T]))).toMatchObject({ status: "aksesibel", available: 3, relevant: 3 });
  });

  it("gives Tidak aksesibel when the ramp is unavailable, whatever else is there", () => {
    const r = computeStatus(facilities([X, T, T, T], { 0: "rusak" }));
    expect(r).toMatchObject({ status: "tidak_aksesibel", available: 3, relevant: 4 });
    expect(r.because).toEqual([{ facility: "ramp", answer: X, reason: "rusak" }]);
  });

  it("gives Belum diketahui when the entrance is unknown", () => {
    expect(computeStatus(facilities([U, T, T, T]))).toMatchObject({ status: "belum_diketahui", unknown: 1, because: [{ facility: "ramp", answer: U }] });
  });

  it("gives Belum diketahui when at least half the relevant facilities are unknown", () => {
    const r = computeStatus(facilities([T, U, U, T]));
    expect(r).toMatchObject({ status: "belum_diketahui", available: 2, relevant: 4, unknown: 2 });
    expect(r.because.map((f) => f.facility)).toEqual(["toilet_difabel", "guiding_block"]);
  });

  it("gives Sebagian when fewer than half are unknown, listing unavailable before unknown", () => {
    const r = computeStatus(facilities([T, U, X, T], { 2: "terhalang" }));
    expect(r).toMatchObject({ status: "sebagian", available: 2, relevant: 4, unknown: 1 });
    expect(r.because.map((f) => f.facility)).toEqual(["guiding_block", "toilet_difabel"]);
  });

  it("treats facilities without an answer as unknown", () => {
    expect(computeStatus([{ facility: "ramp", answer: T }])).toMatchObject({ status: "belum_diketahui", relevant: 4, unknown: 3 });
  });

  it("gives Aksesibel when no facility is needed at all", () => {
    expect(computeStatus(facilities([N, N, N, N]))).toMatchObject({ status: "aksesibel", available: 0, relevant: 0, because: [] });
  });

  it("ignores input order and extra fields", () => {
    const shuffled = [...facilities([T, N, X, T])].reverse().map((f) => ({ ...f, note: "catatan" }));
    expect(computeStatus(shuffled).because).toEqual([{ facility: "guiding_block", answer: X, reason: null }]);
  });
});
