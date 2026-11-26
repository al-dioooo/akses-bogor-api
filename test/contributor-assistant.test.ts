import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ASSISTANT_TOOLS } from "../src/agent/assistant-registry.js";
import { assistantPrompt } from "../src/agent/assistant-prompt.js";
import { CONTRIBUTOR_ASSISTANT_PROFILE, CONTRIBUTOR_ASSISTANT_TOOLS, contributorAssistantPrompt } from "../src/agent/contributor-assistant.js";
import { runTool, toolDefinitions } from "../src/agent/registry.js";
import type { ToolContext } from "../src/agent/tools.js";
import { loadFacilities, parseFacilities } from "../src/contribute/facilities.js";
import type { Db } from "../src/db/client.js";
import { seedSampleData } from "../src/db/seed.js";
import { placesNamed } from "../src/places/queries.js";
import { createTestDb } from "./helpers/db.js";

let db: Db;
let close: () => Promise<void>;
let halteId: string;
const now = () => new Date("2026-11-26T05:00:00.000Z");
const context = (): ToolContext => ({ db, now });
const COORDINATE = /-6\.\d{3}|106\.\d{3}/;
const run = (name: string, input: unknown) => runTool(context(), name, input, CONTRIBUTOR_ASSISTANT_TOOLS);

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedSampleData(db);
  halteId = (await placesNamed(db, "Halte contoh", 5)).find((p) => p.name === "Halte contoh")!.id;
  await loadFacilities(
    db,
    parseFacilities({ elements: [{ type: "way", id: 77, center: { lat: -6.5705, lon: 106.7645 }, tags: { amenity: "place_of_worship", religion: "muslim", name: "Masjid Uji Bogor Barat" } }] }),
    { url: "https://overpass-api.de/api/interpreter", retrievedAt: now(), sha256: "d".repeat(64) },
  );
}, 60_000);

afterAll(async () => {
  await close();
});

describe("contributor assistant tools", () => {
  it("adds the contributor tools to the public assistant tools, once each", () => {
    const names = CONTRIBUTOR_ASSISTANT_TOOLS.map((tool) => tool.name);
    expect(names).toEqual([...ASSISTANT_TOOLS.map((tool) => tool.name), "find_places_to_contribute", "kecamatan_priority", "show_place_card"]);
    expect(new Set(names).size).toBe(names.length);
    expect(toolDefinitions(CONTRIBUTOR_ASSISTANT_TOOLS)).toHaveLength(names.length);
    expect(CONTRIBUTOR_ASSISTANT_PROFILE.tools).toBe(CONTRIBUTOR_ASSISTANT_TOOLS);
  });

  it("gives places to contribute the same osm id as the other assistant tools, without coordinates", async () => {
    const result = (await run("find_places_to_contribute", { kecamatan: "bogor-barat", category: "masjid" })) as { places: { id: string }[] };
    expect(result.places).toEqual([expect.objectContaining({ id: "osm:way/77", name: "Masjid Uji Bogor Barat", category: "masjid", priorityRank: null })]);
    expect(result.places[0]).not.toHaveProperty("osm");
    expect(JSON.stringify(result)).not.toMatch(COORDINATE);
    expect(await run("show_route", { placeId: "osm:way/77" })).toMatchObject({ kartu: { type: "rute", target: { kind: "osm", osmType: "way", osmId: 77 } } });
  });

  it("shows a place card for an osm id or an AksesBogor id, and only a confirmation goes back to the model", async () => {
    const osm = (await run("show_place_card", { placeId: "osm:way/77" })) as { pesan: string; kartu: object };
    expect(osm.kartu).toMatchObject({ type: "tempat", target: { kind: "osm", osmType: "way", osmId: 77 }, name: "Masjid Uji Bogor Barat" });
    expect(osm.pesan).toBe("Kartu tempat ditampilkan untuk Masjid Uji Bogor Barat.");
    const place = (await run("show_place_card", { placeId: halteId })) as { kartu: object };
    expect(place.kartu).toMatchObject({ type: "tempat", target: { kind: "aksesbogor", placeId: halteId }, name: "Halte contoh", status: "sebagian" });
    await expect(run("show_place_card", { placeId: "osm:node/999999" })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("answers kecamatan_priority with an error while disability data is closed", async () => {
    await expect(run("kecamatan_priority", {})).rejects.toMatchObject({ code: "data_disabilitas_belum_aktif" });
  });
});

describe("contributorAssistantPrompt", () => {
  it("keeps every public assistant rule and adds the contributor rules", () => {
    const prompt = contributorAssistantPrompt();
    expect(prompt.startsWith(assistantPrompt())).toBe(true);
    expect(prompt).toContain("find_places_to_contribute");
    expect(prompt).toContain("show_place_card");
    expect(prompt).toContain("terdaftar di Dinas Sosial, bukan seluruh penduduk");
    expect(CONTRIBUTOR_ASSISTANT_PROFILE.system()).toBe(prompt);
  });

  it("tells the model whether a start point exists but never its value", () => {
    const prompt = contributorAssistantPrompt(undefined, { ...context(), position: { lat: -6.59585, lng: 106.79425 } });
    expect(prompt).toContain("Titik awal pengunjung: sudah dipilih");
    expect(prompt).not.toMatch(COORDINATE);
  });
});
