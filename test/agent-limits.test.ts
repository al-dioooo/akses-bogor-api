import { describe, expect, it } from "vitest";
import { dailyLimit } from "../src/agent/limits.js";

describe("dailyLimit", () => {
  it("counts per key, gives back, and starts over when the day changes", () => {
    let now = new Date("2026-11-22T16:59:00.000Z");
    const limit = dailyLimit(2, () => now, 7);
    expect([limit.take("a"), limit.take("a"), limit.take("a"), limit.take("b")]).toEqual([true, true, false, true]);
    limit.give("a");
    expect(limit.take("a")).toBe(true);
    now = new Date("2026-11-22T17:00:00.000Z");
    expect(limit.take("a")).toBe(true);
  });
});
