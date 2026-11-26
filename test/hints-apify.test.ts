import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFacilities, parseFacilities } from "../src/contribute/facilities.js";
import type { Db } from "../src/db/client.js";
import { actorInput, apifyToken, chargeLimitUsd, estimateUsd, searchPlan, searchUrl, type SearchPlace } from "../src/hints/apify.js";
import { createTestDb } from "./helpers/db.js";

// Tempat OSM palsu, hanya untuk tes. Titiknya di dalam Kota Bogor supaya kecamatannya terisi.
const ELEMENTS = [
  { type: "node", id: 101, lat: -6.5705, lon: 106.7645, tags: { amenity: "place_of_worship", religion: "muslim", name: "Masjid Uji Coba Satu" } },
  { type: "node", id: 102, lat: -6.571, lon: 106.765, tags: { amenity: "place_of_worship", religion: "muslim", name: "Masjid Uji Coba Dua" } },
  { type: "node", id: 103, lat: -6.5712, lon: 106.7652, tags: { amenity: "place_of_worship", religion: "muslim", name: "Mushola" } },
  { type: "node", id: 104, lat: -6.5715, lon: 106.7655, tags: { amenity: "place_of_worship", religion: "muslim" } },
  { type: "node", id: 201, lat: -6.5958, lon: 106.7942, tags: { highway: "bus_stop", name: "Halte Uji Coba" } },
  { type: "node", id: 202, lat: -6.596, lon: 106.7945, tags: { highway: "bus_stop", name: "Halte Bus" } },
  { type: "node", id: 301, lat: -6.5701, lon: 106.764, tags: { amenity: "hospital", name: "RS Contoh Palsu" } },
] as const;

const PLACE: SearchPlace = { osmType: "node", osmId: 101, category: "masjid", name: "Masjid Uji Coba & Satu", lat: -6.57051234, lng: 106.76451234 };

describe("Apify search for Google Maps attributes", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await loadFacilities(db, parseFacilities({ elements: [...ELEMENTS] }), { url: "https://overpass.example/palsu", retrievedAt: new Date("2026-11-20T00:00:00Z"), sha256: "a".repeat(64) });
  }, 60_000);

  afterAll(async () => {
    await close();
  });

  it("searches only named places with a distinctive word, taking turns across categories", async () => {
    const plan = await searchPlan(db);
    expect(plan.unnamed).toBe(1);
    expect(plan.generic).toBe(2);
    expect(plan.places.map((p) => `${p.category} ${p.name}`)).toEqual([
      "masjid Masjid Uji Coba Dua",
      "halte Halte Uji Coba",
      "rumah_sakit RS Contoh Palsu",
      "masjid Masjid Uji Coba Satu",
    ]);
    expect(plan.places[1]).toMatchObject({ osmType: "node", osmId: 201, lat: -6.5958, lng: 106.7942 });
  });

  it("keeps every category in a small --limit run", async () => {
    const plan = await searchPlan(db, 3);
    expect(plan.places.map((p) => p.category)).toEqual(["masjid", "halte", "rumah_sakit"]);
  });

  it("builds one Indonesian Google Maps search URL around the OSM point", () => {
    expect(searchUrl(PLACE)).toBe("https://www.google.com/maps/search/Masjid%20Uji%20Coba%20%26%20Satu/@-6.570512,106.764512,17z?hl=id");
  });

  it("asks the actor for the top results only, in Indonesian, with every paid add-on and personal data off", () => {
    const input = actorInput([PLACE, { ...PLACE, osmId: 102, name: "Masjid Uji Coba Dua" }], 1);
    expect(input.startUrls).toHaveLength(2);
    expect(input).toMatchObject({ maxCrawledPlacesPerSearch: 1, language: "id", scrapePlaceDetailPage: false, scrapeContacts: false, scrapeReviewsPersonalData: false });
    expect([input.maxReviews, input.maxImages, input.maxQuestions, input.maximumLeadsEnrichmentRecords]).toEqual([0, 0, 0, 0]);
    expect(input).not.toHaveProperty("categoryFilterWords");
  });

  it("estimates the worst case and caps the run a little above it", () => {
    expect(estimateUsd(500, 1)).toBeCloseTo(2);
    expect(estimateUsd(500, 2)).toBeCloseTo(4);
    expect(chargeLimitUsd(2)).toBe(3);
    expect(chargeLimitUsd(0.04)).toBe(0.5);
  });
});

describe("Apify token", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "apify-token-"));
    await writeFile(join(dir, "apify.env"), "# token palsu\nAPIFY_TOKEN=apify_api_palsu_dari_berkas\n");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("prefers APIFY_TOKEN, then the env file, and is null when neither exists", async () => {
    const file = join(dir, "apify.env");
    expect(await apifyToken({ APIFY_TOKEN: " apify_api_palsu_env ", APIFY_ENV_FILE: file })).toBe("apify_api_palsu_env");
    expect(await apifyToken({ APIFY_TOKEN: "", APIFY_ENV_FILE: file })).toBe("apify_api_palsu_dari_berkas");
    expect(await apifyToken({ APIFY_ENV_FILE: join(dir, "tidak-ada.env") })).toBeNull();
  });
});
