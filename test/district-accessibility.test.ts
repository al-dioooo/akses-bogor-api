import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { loadFacilities, parseFacilities } from "../src/contribute/facilities.js";
import type { Db } from "../src/db/client.js";
import { seedSampleData } from "../src/db/seed.js";
import { MINIMUM_PLACES, entranceOf, osmEntrance, rankAccessibility } from "../src/hints/districts.js";
import { createTestDb } from "./helpers/db.js";

const google = (entrance: boolean, diambil: string) => ({
  nama: "Tempat di Google",
  place_id: "ChIJcontoh",
  aksesibilitas: entrance ? ["wheelchairAccessibleEntrance"] : [],
  tidak_tersedia: entrance ? [] : ["wheelchairAccessibleEntrance"],
  diambil,
});

describe("entrance sources", () => {
  it("reads the OSM wheelchair values and ignores the rest", () => {
    expect(["yes", "designated", "limited", "no", "unknown", null].map(osmEntrance)).toEqual(["bisa", "bisa", "terbatas", "tidak", null, null]);
  });

  it("takes the AksesBogor ramp answer, with Tidak perlu as a level entrance", () => {
    expect(entranceOf({ kind: "aksesbogor", ramp: "tidak_perlu" }, true)).toEqual({ entrance: "bisa", source: "aksesbogor" });
    expect(entranceOf({ kind: "aksesbogor", ramp: "tidak_tersedia" }, true)).toEqual({ entrance: "tidak", source: "aksesbogor" });
    expect(entranceOf({ kind: "aksesbogor", ramp: "belum_tahu" }, true)).toBeNull();
  });

  it("prefers the place's own OSM tag, then the stored OSM note, then the stored Google copy, and reads copies only when stored hints are on", () => {
    const copy = google(false, "2026-11-22T20:15:00Z");
    expect(entranceOf({ kind: "osm", wheelchair: "yes", google: copy, osmNote: { wheelchair: "no" } }, true)).toEqual({ entrance: "bisa", source: "openstreetmap" });
    expect(entranceOf({ kind: "osm", wheelchair: null, google: copy, osmNote: { wheelchair: "limited" } }, true)).toEqual({ entrance: "terbatas", source: "openstreetmap" });
    expect(entranceOf({ kind: "osm", wheelchair: null, google: copy, osmNote: null }, true)).toEqual({ entrance: "tidak", source: "google_maps", retrievedAt: "2026-11-23" });
    expect(entranceOf({ kind: "osm", wheelchair: null, google: copy, osmNote: { wheelchair: "yes" } }, false)).toBeNull();
    // Salinan Google tanpa keterangan pintu masuk tidak dihitung.
    expect(entranceOf({ kind: "osm", wheelchair: null, google: { ...copy, tidak_tersedia: ["wheelchairAccessibleRestroom"] }, osmNote: null }, true)).toBeNull();
  });

  it("ranks by score, then by places with data, then by name, and leaves kecamatan with too little data unranked", () => {
    const district = (name: string, withData: number, accessible: number) => ({
      slug: name.toLowerCase(),
      name,
      places: withData + 3,
      withData,
      accessible,
      limited: 0,
      notAccessible: withData - accessible,
      bySource: { aksesbogor: { withData: 0, accessible: 0 }, openstreetmap: { withData, accessible }, google_maps: { withData: 0, accessible: 0 } },
    });
    const ranked = rankAccessibility([district("C", 10, 5), district("A", 4, 4), district("B", 6, 3), district("D", 5, 4)]);
    expect(ranked.map((d) => [d.name, d.score, d.rank])).toEqual([
      ["D", 80, 1],
      ["C", 50, 2],
      ["B", 50, 3],
      ["A", null, null],
    ]);
    expect(MINIMUM_PLACES).toBe(5);
  });
});

describe("GET /districts/accessibility", () => {
  let db: Db;
  let close: () => Promise<void>;
  let withHints: Awaited<ReturnType<typeof buildApp>>;
  let withoutHints: Awaited<ReturnType<typeof buildApp>>;
  const base = { NODE_ENV: "test", DATABASE_URL: "postgresql://test@localhost/test" };
  const raw = { url: "https://overpass-api.de/api/interpreter", retrievedAt: new Date("2026-11-22T10:00:00.000Z"), sha256: "f".repeat(64) };
  const masjid = (id: number, lon: number, lat: number, wheelchair?: string) => ({
    type: "node" as const,
    id,
    lat,
    lon,
    tags: { amenity: "place_of_worship", religion: "muslim", name: `Masjid ${id}`, ...(wheelchair ? { wheelchair } : {}) },
  });

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    // Contoh: satu lokasi AksesBogor per kecamatan; Halte contoh (Bogor Tengah) dan Rumah sakit contoh (Bogor Barat)
    // pintu masuknya Tersedia.
    await seedSampleData(db);
    const elements = [
      // Bogor Tengah, di Kebun Raya.
      masjid(1, 106.7975, -6.597, "yes"),
      masjid(2, 106.7985, -6.5975, "limited"),
      masjid(3, 106.7995, -6.598, "no"),
      masjid(4, 106.8005, -6.5985),
      masjid(5, 106.7975, -6.599),
      masjid(6, 106.7985, -6.5995, "yes"),
      masjid(7, 106.7995, -6.6),
      // Halte OSM 25 m dari Halte contoh: sudah punya data AksesBogor, jadi tidak dihitung.
      { type: "node" as const, id: 8, lat: -6.5959, lon: 106.7944, tags: { highway: "bus_stop", name: "Halte 8", wheelchair: "no" } },
      // Bogor Barat, di sekitar Rumah sakit contoh.
      ...[
        [106.76, -6.572],
        [106.761, -6.573],
        [106.762, -6.574],
        [106.763, -6.575],
        [106.766, -6.572],
      ].map(([lon, lat], i) => masjid(20 + i, lon!, lat!, "yes")),
    ];
    await loadFacilities(db, parseFacilities({ elements }), raw);
    const tag = (id: number, key: string, value: unknown) =>
      db.execute(sql`UPDATE osm_places SET tags = tags || jsonb_build_object(${key}::text, ${JSON.stringify(value)}::jsonb) WHERE osm_type = 'node' AND osm_id = ${id}`);
    await tag(4, "aksesbogor:google_maps", google(true, "2026-11-22T20:15:00Z"));
    await tag(5, "aksesbogor:osm_aksesibilitas", { wheelchair: "yes", arti: "bisa dimasuki kursi roda" });
    // Tag OSM tempat itu sendiri menang atas salinan Google, jadi tanggal salinan ini tidak dipakai.
    await tag(6, "aksesbogor:google_maps", google(false, "2026-11-25T01:00:00Z"));
    withHints = await buildApp(loadEnv({ ...base, PROVIDER_HINTS_ENABLED: "true" }), { db });
    withoutHints = await buildApp(loadEnv(base), { db });
    await Promise.all([withHints.ready(), withoutHints.ready()]);
  }, 60_000);

  afterAll(async () => {
    await Promise.all([withHints.close(), withoutHints.close()]);
    await close();
  });

  const fetchBody = async (app: typeof withHints) => {
    const res = await app.inject({ method: "GET", url: "/districts/accessibility" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    return res.json();
  };
  const find = (body: { districts: { slug: string }[] }, slug: string) => body.districts.find((d) => d.slug === slug);

  it("counts each place once from its first source, with the stored copies while hints are on", async () => {
    const body = await fetchBody(withHints);
    expect(body).toMatchObject({ minimumPlaces: 5, caveat: expect.stringMatching(/^Keterangan dari OpenStreetMap dan Google Maps belum diperiksa tim/) });
    expect(find(body, "bogor-tengah")).toEqual({
      slug: "bogor-tengah",
      name: "Bogor Tengah",
      places: 8,
      withData: 7,
      accessible: 5,
      limited: 1,
      notAccessible: 1,
      score: 71,
      rank: 2,
      bySource: { aksesbogor: { withData: 1, accessible: 1 }, openstreetmap: { withData: 5, accessible: 3 }, google_maps: { withData: 1, accessible: 1 } },
    });
    expect(find(body, "bogor-barat")).toMatchObject({ places: 6, withData: 6, accessible: 6, score: 100, rank: 1 });
    expect(body.sources).toEqual({
      aksesbogor: { checkedByTeam: true },
      openstreetmap: { checkedByTeam: false, attribution: "© kontributor OpenStreetMap", url: "https://www.openstreetmap.org/copyright", retrievedAt: "2026-11-22T10:00:00.000Z" },
      google_maps: { checkedByTeam: false, attribution: "Google Maps", retrievedAt: "2026-11-23" },
    });
  });

  it("leaves out the stored OSM and Google copies, and Google itself, while hints are off", async () => {
    const body = await fetchBody(withoutHints);
    expect(find(body, "bogor-tengah")).toMatchObject({ withData: 5, accessible: 3, score: 60, rank: 2, bySource: { google_maps: { withData: 0, accessible: 0 } } });
    expect(body.sources.google_maps).toBeNull();
    expect(JSON.stringify(body)).not.toMatch(/google maps/i);
  });

  it("lists every kecamatan, with too little data unranked after the ranked ones", async () => {
    const body = await fetchBody(withHints);
    expect(body.districts).toHaveLength(6);
    expect(body.districts.map((d: { rank: number | null }) => d.rank)).toEqual([1, 2, null, null, null, null]);
    // Tanah Sareal: Kampus contoh A (Tersedia) dan Halte contoh B (Belum tahu).
    expect(find(body, "tanah-sareal")).toMatchObject({ places: 2, withData: 1, accessible: 1, score: null, rank: null });
  });
});
