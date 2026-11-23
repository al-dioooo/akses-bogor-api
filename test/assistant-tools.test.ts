import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { askAgent, type AgentProfile } from "../src/agent/ask.js";
import { loadFacilities, parseFacilities } from "../src/contribute/facilities.js";
import { ASSISTANT_TOOLS } from "../src/agent/assistant-registry.js";
import {
  CANDIDATE_SOURCE,
  findPlaceForAssistant,
  nearbyPlaces,
  parseCandidateId,
  placeAccessibilityForAssistant,
  roundDistance,
  showRoute,
  TEAM_CHECKED_SOURCE,
} from "../src/agent/assistant-tools.js";
import type { AgentModel, AgentStep, AgentTurn } from "../src/agent/model.js";
import { runTool, toolDefinitions } from "../src/agent/registry.js";
import type { ToolContext } from "../src/agent/tools.js";
import type { Db } from "../src/db/client.js";
import { seedSampleData } from "../src/db/seed.js";
import { placesNamed } from "../src/places/queries.js";
import { createTestDb } from "./helpers/db.js";

let db: Db;
let close: () => Promise<void>;
let halteId: string;
const now = () => new Date("2026-11-23T05:00:00.000Z");
/** Beberapa meter dari Halte contoh (106.7942, -6.5958) di Bogor Tengah. */
const nearHalte = { lat: -6.59585, lng: 106.79425 };
const context = (position?: { lat: number; lng: number }): ToolContext => ({ db, now, position });
const COORDINATE = /-6\.\d{3}|106\.\d{3}/;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedSampleData(db);
  halteId = (await placesNamed(db, "Halte contoh", 5)).find((p) => p.name === "Halte contoh")!.id;
}, 60_000);

afterAll(async () => {
  await close();
});

describe("find_place for the assistant", () => {
  it("finds places by name, category, or kecamatan, without coordinates", async () => {
    expect((await findPlaceForAssistant(context(), { query: "halte" })).places.map((p) => p.name).sort()).toEqual(["Halte contoh", "Halte contoh B"]);
    expect((await findPlaceForAssistant(context(), { category: "masjid" })).places.map((p) => p.name)).toEqual(["Masjid contoh A", "Masjid contoh B"]);
    expect((await findPlaceForAssistant(context(), { kecamatan: "tanah-sareal" })).places.map((p) => p.name)).toEqual(["Halte contoh B", "Kampus contoh A"]);
    const { places } = await findPlaceForAssistant(context(), { query: "contoh", category: "halte", kecamatan: "tanah-sareal" });
    expect(places).toEqual([
      { id: expect.any(String), kind: "lokasi", name: "Halte contoh B", category: "halte", status: expect.any(String), district: { slug: "tanah-sareal", name: "Tanah Sareal" }, checkedByTeam: true, source: TEAM_CHECKED_SOURCE },
    ]);
    expect(JSON.stringify(places)).not.toMatch(COORDINATE);
  });

  it("asks for at least one filter", async () => {
    await expect(runTool(context(), "find_place", {}, ASSISTANT_TOOLS)).rejects.toMatchObject({ statusCode: 400, code: "input_tidak_valid" });
  });
});

describe("place_accessibility for the assistant", () => {
  it("adds whether the team checked the answers and where they come from", async () => {
    const place = await placeAccessibilityForAssistant(context(), { placeId: halteId });
    expect(place).toMatchObject({ name: "Halte contoh", status: "sebagian", checkedByTeam: true, source: TEAM_CHECKED_SOURCE });
    expect(place).not.toHaveProperty("location");
  });
});

describe("nearby_places", () => {
  it("lists the nearest places with distances rounded to 100 m and never a coordinate", async () => {
    const result = await nearbyPlaces(context(nearHalte), {});
    expect(result.places[0]).toEqual({
      id: halteId,
      kind: "lokasi",
      name: "Halte contoh",
      category: "halte",
      status: "sebagian",
      district: { slug: "bogor-tengah", name: "Bogor Tengah" },
      distanceMeters: 100,
      checkedByTeam: true,
      source: TEAM_CHECKED_SOURCE,
    });
    expect(result.places.length).toBeLessThanOrEqual(5);
    for (const p of result.places) expect(p.distanceMeters % 100).toBe(0);
    const distances = result.places.map((p) => p.distanceMeters);
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);
    expect(JSON.stringify(result)).not.toMatch(COORDINATE);
    expect(result.note).toContain("garis lurus");
  });

  it("filters by category and status", async () => {
    const masjid = await nearbyPlaces(context(nearHalte), { category: "masjid" });
    expect(masjid.places.map((p) => p.name)).toEqual(["Masjid contoh A", "Masjid contoh B"]);
    // Masjid contoh A sekitar 2,4 km dari halte: jarak garis lurus PostGIS, dibulatkan.
    expect(masjid.places[0]!.distanceMeters).toBeGreaterThan(2000);
    expect(masjid.places[0]!.distanceMeters).toBeLessThan(3000);
    const accessible = await nearbyPlaces(context(nearHalte), { status: ["aksesibel"], limit: 1 });
    expect(accessible.places).toHaveLength(1);
    expect(accessible.places[0]).toMatchObject({ kind: "lokasi", status: "aksesibel" });
  });

  it("answers an error the model can pass on when there is no start point or it is outside Kota Bogor", async () => {
    await expect(nearbyPlaces(context(), {})).rejects.toMatchObject({ statusCode: 422, code: "posisi_belum_ada" });
    await expect(nearbyPlaces(context({ lat: -6.2, lng: 106.8 }), {})).rejects.toMatchObject({ statusCode: 422, code: "di_luar_kota_bogor" });
  });

  it("rounds distances so that they never point at the visitor", () => {
    expect([0, 49, 50, 149, 151, 1234].map(roundDistance)).toEqual([100, 100, 100, 100, 200, 1200]);
  });
});

describe("show_route", () => {
  it("returns a route card for the web and only a short confirmation", async () => {
    const result = await showRoute(context(), { placeId: halteId });
    expect(result.kartu).toEqual({ type: "rute", target: { kind: "aksesbogor", placeId: halteId }, name: "Halte contoh" });
    expect(result.pesan).toContain("Anda tidak menerima rute itu");
  });

  it("answers 404 for an unknown place", async () => {
    await expect(showRoute(context(), { placeId: "00000000-0000-4000-8000-000000000000" })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("assistant tool list", () => {
  it("has the five assistant tools and none of the contributor tools", async () => {
    expect(toolDefinitions(ASSISTANT_TOOLS).map((t) => t.function.name)).toEqual(["find_place", "place_accessibility", "search_knowledge", "nearby_places", "show_route"]);
    await expect(runTool(context(), "find_places_to_contribute", {}, ASSISTANT_TOOLS)).rejects.toMatchObject({ statusCode: 404, code: "alat_tidak_dikenal" });
    await expect(runTool(context(), "show_route_card", { placeId: halteId }, ASSISTANT_TOOLS)).rejects.toMatchObject({ code: "alat_tidak_dikenal" });
  });
});

describe("askAgent with the assistant tools", () => {
  const profile: AgentProfile = { tools: ASSISTANT_TOOLS, system: () => "uji", guard: (text, seen) => `${text} [${seen.checkedPlace}]` };

  it("keeps the position on the server, sends only rounded distances, and hands the route card to the web", async () => {
    const turns: AgentTurn[] = [
      { kind: "tool_calls", calls: [{ id: "1", name: "nearby_places", input: { category: "halte" } }] },
      { kind: "tool_calls", calls: [{ id: "2", name: "show_route", input: { placeId: halteId } }] },
      { kind: "answer", text: "Halte contoh sekitar 100 m dari titik awal Anda." },
    ];
    const steps: AgentStep[] = [];
    const model: AgentModel = { next: vi.fn(async (step: AgentStep) => (steps.push(structuredClone({ ...step, signal: undefined })), turns.shift()!)) };
    const result = await askAgent({ model, ctx: context(nearHalte), profile }, { question: "Halte terdekat?" });
    expect(result.cards).toEqual([{ type: "rute", target: { kind: "aksesbogor", placeId: halteId }, name: "Halte contoh" }]);
    expect(result.answer).toBe("Halte contoh sekitar 100 m dari titik awal Anda. [true]");
    expect(steps[0]!.tools.map((t) => t.function.name)).toContain("nearby_places");
    expect(JSON.stringify(steps)).not.toMatch(COORDINATE);
    const routeResult = steps[2]!.messages.at(-1)!;
    expect(routeResult).toMatchObject({ role: "tool", name: "show_route" });
    expect(JSON.parse((routeResult as { content: string }).content)).toEqual({ pesan: expect.stringContaining("Kartu rute ditampilkan untuk Halte contoh") });
  });
});

describe("OpenStreetMap candidates", () => {
  beforeAll(async () => {
    // RSUD Uji tanpa lokasi AksesBogor di dekatnya, dan halte OSM 5 m dari Halte contoh yang tidak boleh menjadi kandidat.
    await loadFacilities(
      db,
      parseFacilities({
        elements: [
          { type: "node", id: 31, lat: -6.58, lon: 106.8, tags: { amenity: "hospital", name: "RSUD Uji Kota Bogor", "aksesbogor:google_maps": "ramp ada" } },
          { type: "node", id: 32, lat: -6.59584, lon: 106.79424, tags: { highway: "bus_stop", name: "Halte OSM kembar" } },
        ],
      }),
      { url: "https://overpass-api.de/api/interpreter", retrievedAt: now(), sha256: "c".repeat(64) },
    );
  });

  it("finds a candidate by name, without status, coordinates or third-party tags", async () => {
    const { places, catatan } = (await findPlaceForAssistant(context(), { query: "rsud uji" })) as { places: object[]; catatan?: string };
    expect(places).toEqual([
      { id: "osm:node/31", kind: "kandidat", name: "RSUD Uji Kota Bogor", category: "rumah_sakit", district: expect.objectContaining({ slug: expect.any(String) }), checkedByTeam: false, source: CANDIDATE_SOURCE },
    ]);
    expect(catatan).toContain("belum ada data aksesibilitas dari tim AksesBogor");
    expect(JSON.stringify(places)).not.toMatch(COORDINATE);
    expect(JSON.stringify(places)).not.toContain("ramp ada");
    expect((await findPlaceForAssistant(context(), { query: "halte osm kembar" })).places).toEqual([]);
  });

  it("lists candidates among the nearest places, but not when a status is asked for", async () => {
    const { places } = await nearbyPlaces(context(nearHalte), { category: "rumah_sakit" });
    expect(places[0]).toMatchObject({ id: "osm:node/31", kind: "kandidat", checkedByTeam: false, distanceMeters: expect.any(Number) });
    expect(places[0]).not.toHaveProperty("status");
    expect(places.map((p) => p.id)).not.toContain("osm:node/32");
    const accessible = await nearbyPlaces(context(nearHalte), { category: "rumah_sakit", status: ["aksesibel"] });
    expect(accessible.places.every((p) => p.kind === "lokasi")).toBe(true);
  });

  it("says a candidate has no team data, and shows a route card to its OpenStreetMap point", async () => {
    expect(await placeAccessibilityForAssistant(context(), { placeId: "osm:node/31" })).toMatchObject({ kind: "kandidat", checkedByTeam: false, facilities: [] });
    const route = await showRoute(context(), { placeId: "osm:node/31" });
    expect(route.kartu).toEqual({ type: "rute", target: { kind: "osm", osmType: "node", osmId: 31 }, name: "RSUD Uji Kota Bogor" });
    expect(route.pesan).toContain("belum punya data aksesibilitas");
    await expect(showRoute(context(), { placeId: "osm:node/99" })).rejects.toMatchObject({ statusCode: 404 });
    expect(parseCandidateId("osm:way/142616948")).toEqual({ osmType: "way", osmId: 142616948 });
    expect(parseCandidateId("osm:area/1")).toBeNull();
  });

  it("accepts candidate ids in the tool schemas and cites OpenStreetMap as a source", async () => {
    const turns: AgentTurn[] = [
      { kind: "tool_calls", calls: [{ id: "1", name: "find_place", input: { query: "RSUD Uji" } }] },
      { kind: "tool_calls", calls: [{ id: "2", name: "show_route", input: { placeId: "osm:node/31" } }, { id: "3", name: "place_accessibility", input: { placeId: "osm:node/31" } }] },
      { kind: "answer", text: "RSUD Uji Kota Bogor belum ada data aksesibilitas dari tim AksesBogor." },
    ];
    const model: AgentModel = { next: vi.fn(async () => turns.shift()!) };
    const profile: AgentProfile = { tools: ASSISTANT_TOOLS, system: () => "uji", guard: (text) => text };
    const result = await askAgent({ model, ctx: context(), profile }, { question: "Rute ke RSUD Uji?" });
    expect(result.cards).toEqual([{ type: "rute", target: { kind: "osm", osmType: "node", osmId: 31 }, name: "RSUD Uji Kota Bogor" }]);
    expect(result.sources).toEqual([expect.objectContaining({ type: "pengetahuan", citation: "© kontributor OpenStreetMap", license: "Open Database License (ODbL) 1.0" })]);
  });
});
