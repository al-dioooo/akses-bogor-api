import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WAY, parseWayFlags, wayFlagsFile } from "../src/map/accessible-ways.js";

describe("wayFlagsFile", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "jalur-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads the file again after the tiles are rebuilt", async () => {
    const path = join(dir, "jalur.json");
    let clock = 0;
    const source = wayFlagsFile(path, { now: () => clock, checkEveryMs: 1000 });
    expect(await source()).toBeNull();

    await writeFile(path, JSON.stringify({ versi: 1, sumber: "java-latest.osm.pbf 2026-11-18", jalur: { 5: WAY.sidewalkKnown } }));
    clock = 2000;
    const first = await source();
    expect(first?.flagsOf(5)).toBe(WAY.sidewalkKnown);
    expect(first?.dataDate).toBe("2026-11-18");

    await writeFile(path, JSON.stringify({ versi: 1, sumber: "java-latest.osm.pbf 2026-11-25", jalur: { 5: WAY.surfaceKnown } }));
    await utimes(path, new Date(), new Date(Date.now() + 5000));
    clock = 2500;
    expect((await source())?.dataDate).toBe("2026-11-18");
    clock = 4000;
    const second = await source();
    expect(second?.flagsOf(5)).toBe(WAY.surfaceKnown);
    expect(second?.flagsOf(6)).toBe(0);
  });

  it("refuses a file of another version", () => {
    expect(() => parseWayFlags(JSON.stringify({ versi: 2, jalur: {} }))).toThrow();
  });
});
