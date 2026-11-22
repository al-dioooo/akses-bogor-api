import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENT_TOOLS, runTool, toolDefinitions } from "../src/agent/registry.js";
import type { Db } from "../src/db/client.js";
import { seedSampleData } from "../src/db/seed.js";
import { createTestDb } from "./helpers/db.js";

let db: Db;
let close: () => Promise<void>;
const ctx = () => ({ db, now: () => new Date("2026-11-16T05:00:00.000Z") });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedSampleData(db);
}, 60_000);

afterAll(async () => {
  await close();
});

describe("tool registry", () => {
  it("offers only the model tools, never a route or the user's position", () => {
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual(["find_place", "place_accessibility", "search_knowledge", "find_places_to_contribute", "kecamatan_priority"]);
    expect(JSON.stringify(toolDefinitions())).not.toMatch(/"(from|lat|lng|polyline|geometry)"/);
  });

  it("builds an OpenAI-style tools array with plain JSON Schema parameters", () => {
    const definitions = toolDefinitions();
    expect(definitions.map((d) => d.function.name)).toEqual(AGENT_TOOLS.map((t) => t.name));
    for (const d of definitions) {
      expect(d.type).toBe("function");
      expect(d.function.description.length).toBeGreaterThan(40);
      expect(d.function.parameters).toMatchObject({ type: "object" });
      expect(d.function.parameters).not.toHaveProperty("$schema");
    }
    expect(definitions.find((d) => d.function.name === "place_accessibility")!.function.parameters).toMatchObject({
      required: ["placeId"],
      properties: { placeId: { type: "string", format: "uuid" } },
    });
  });

  it("runs a tool by name after checking its input", async () => {
    const result = (await runTool(ctx(), "find_place", { query: "masjid contoh" })) as { places: { name: string }[] };
    expect(result.places.map((p) => p.name)).toEqual(["Masjid contoh A", "Masjid contoh B"]);
  });

  it("rejects unknown tools and input that does not match the schema", async () => {
    await expect(runTool(ctx(), "hapus_semua", {})).rejects.toMatchObject({ statusCode: 404, code: "alat_tidak_dikenal" });
    await expect(runTool(ctx(), "find_place", { query: "x" })).rejects.toMatchObject({ statusCode: 400, code: "input_tidak_valid" });
    await expect(runTool(ctx(), "walking_route", { from: { lat: -6.6, lng: 106.8 }, placeId: "1" })).rejects.toMatchObject({ statusCode: 404 });
    await expect(runTool(ctx(), "place_accessibility", { placeId: "1" })).rejects.toMatchObject({ statusCode: 400 });
  });
});
