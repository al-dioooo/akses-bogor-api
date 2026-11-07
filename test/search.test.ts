import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/client.js";
import { seedSampleData } from "../src/db/seed.js";
import { mapboxSearch, SearchQuotaError } from "../src/map/search.js";
import { placesNamed } from "../src/places/queries.js";
import { createTestDb } from "./helpers/db.js";

const now = () => new Date("2026-11-07T10:00:00.000Z");

const feature = (name: string, lng: number, lat: number, extra: Record<string, string> = {}) => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lng, lat] },
  properties: { name, feature_type: "poi", ...extra },
});
const mapboxAnswer = () =>
  Response.json({
    type: "FeatureCollection",
    features: [
      feature("Masjid Raya Bogor", 106.8104, -6.5871, { full_address: "Jl. Raya Pajajaran, Bogor Timur, Kota Bogor" }),
      feature("Kelurahan Paledang", 106.792, -6.601, { place_formatted: "Kelurahan Paledang" }),
      { type: "Feature", properties: { name: "Tanpa geometri" } },
    ],
  });

describe("mapboxSearch", () => {
  it("asks Search Box around Kota Bogor and keeps results with a point", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => mapboxAnswer());
    const run = mapboxSearch({ token: "sk.rahasia", now, fetch });
    expect(await run("masjid raya", { lat: -6.6, lng: 106.8 })).toEqual([
      { name: "Masjid Raya Bogor", address: "Jl. Raya Pajajaran, Bogor Timur, Kota Bogor", location: { lat: -6.5871, lng: 106.8104 }, kind: "poi" },
      { name: "Kelurahan Paledang", address: null, location: { lat: -6.601, lng: 106.792 }, kind: "poi" },
    ]);
    const url = new URL(String(fetch.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe("https://api.mapbox.com/search/searchbox/v1/forward");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      q: "masjid raya",
      access_token: "sk.rahasia",
      auto_complete: "true",
      bbox: "106.72,-6.69,106.86,-6.5",
      proximity: "106.8,-6.6",
      country: "id",
      language: "id",
      limit: "5",
    });
  });

  it("stops after the daily limit and starts again after midnight WIB", async () => {
    let time = new Date("2026-11-07T16:59:00.000Z"); // 23.59 WIB
    const fetch = vi.fn<typeof globalThis.fetch>(async () => mapboxAnswer());
    const run = mapboxSearch({ token: "sk.rahasia", now: () => time, fetch, perDay: 2 });
    await run("a");
    await run("b");
    await expect(run("c")).rejects.toBeInstanceOf(SearchQuotaError);
    expect(fetch).toHaveBeenCalledTimes(2);
    time = new Date("2026-11-07T17:00:00.000Z"); // 00.00 WIB
    await expect(run("d")).resolves.toHaveLength(2);
  });

  it("fails without the token in the message", async () => {
    const offline = mapboxSearch({ token: "sk.rahasia", now, fetch: async () => Promise.reject(new TypeError("fetch failed ?access_token=sk.rahasia")) });
    await expect(offline("halte")).rejects.toThrow("Mapbox Search Box tidak bisa dihubungi");
    const refused = mapboxSearch({ token: "sk.rahasia", now, fetch: async () => Response.json({ message: "Not Authorized" }, { status: 401 }) });
    await expect(refused("halte")).rejects.toThrow("Mapbox Search Box menjawab 401");
  });
});

describe("placesNamed", () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await seedSampleData(db);
  }, 60_000);

  afterAll(async () => {
    await close();
  });

  const names = async (q: string) => (await placesNamed(db, q)).map((p) => p.name);

  it("needs every word, or a near spelling", async () => {
    expect(await names("halte contoh")).toEqual(["Halte contoh", "Halte contoh B"]);
    expect(await names("Masjid")).toEqual(["Masjid contoh A", "Masjid contoh B"]);
    expect(await names("masjid raya")).toEqual([]);
    expect(await names("halte contho")).toEqual(["Halte contoh", "Halte contoh B"]);
  });

  it("returns the kecamatan and point of each place", async () => {
    const [place] = await placesNamed(db, "masjid contoh a");
    expect(place).toMatchObject({ name: "Masjid contoh A", category: "masjid", district: { slug: "bogor-timur", name: "Bogor Timur" }, location: { lat: -6.605, lng: 106.813 } });
  });
});
