import { describe, expect, it } from "vitest";
import { googleHints } from "../src/hints/google.js";
import { mapboxHints } from "../src/hints/mapbox.js";
import { lookupHints } from "../src/hints/provider.js";

const SILOAM = { lat: -6.59567, lng: 106.80465 };
const target = { name: "RS Siloam Bogor", location: SILOAM, category: "rumah_sakit" as const };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Fetch palsu yang mencatat setiap panggilan dan menjawab menurut path. */
function fakeFetch(answer: (url: URL, init?: RequestInit) => Response) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return answer(url, init);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("Mapbox hints", () => {
  const mapbox = (url: URL) =>
    url.pathname.endsWith("/forward")
      ? json({
          features: [
            { geometry: { coordinates: [106.80481, -6.59218] }, properties: { name: "Pool Taxol Siloam", mapbox_id: "taksi", poi_category_ids: ["parking_lot", "transportation"] } },
            { geometry: { coordinates: [106.80464507, -6.59567111] }, properties: { name: "Siloam Hospitals Bogor", mapbox_id: "siloam", poi_category_ids: ["health_services", "hospital"] } },
          ],
        })
      : json({ features: [{ properties: { name: "Siloam Hospitals Bogor", metadata: { wheelchair_accessible: true } } }] });

  it("finds the matching place with forward, reads the flag with retrieve, and caches it for 10 minutes", async () => {
    let time = new Date("2026-11-23T03:00:00Z");
    const { fetch, calls } = fakeFetch(mapbox);
    const provider = mapboxHints({ token: "sk.rahasia", now: () => time, fetch });
    expect(await provider.lookup(target)).toEqual({ provider: "mapbox", result: "found", placeName: "Siloam Hospitals Bogor", distanceMeters: 1, wheelchairAccessible: true });
    expect(calls.map((c) => c.url.pathname)).toEqual(["/search/searchbox/v1/forward", "/search/searchbox/v1/retrieve/siloam"]);
    expect(calls[0]!.url.searchParams.get("proximity")).toBe("106.80465,-6.59567");
    expect(calls[1]!.url.searchParams.get("session_token")).toMatch(/^[0-9a-f-]{36}$/);

    time = new Date("2026-11-23T03:09:00Z");
    await provider.lookup(target);
    expect(calls).toHaveLength(2);
    time = new Date("2026-11-23T03:11:00Z");
    await provider.lookup(target);
    expect(calls).toHaveLength(4);
  });

  it("answers none without retrieve when nothing matches, and none when the flag is missing", async () => {
    const nothing = fakeFetch(() => json({ features: [] }));
    expect(await mapboxHints({ token: "sk.x", now: () => new Date(), fetch: nothing.fetch }).lookup(target)).toEqual({ provider: "mapbox", result: "none" });
    expect(nothing.calls).toHaveLength(1);
    const noFlag = fakeFetch((url) => (url.pathname.endsWith("/forward") ? mapbox(url) : json({ features: [{ properties: { metadata: {} } }] })));
    expect(await mapboxHints({ token: "sk.x", now: () => new Date(), fetch: noFlag.fetch }).lookup(target)).toEqual({ provider: "mapbox", result: "none" });
  });

  it("is unavailable after the daily budget and does not cache failures", async () => {
    const failing = fakeFetch(() => json({ message: "x" }, 500));
    const provider = mapboxHints({ token: "sk.x", now: () => new Date("2026-11-23T03:00:00Z"), fetch: failing.fetch, perDay: 2 });
    const logged: unknown[][] = [];
    expect(await lookupHints(target, [provider], { warn: (...args) => logged.push(args) })).toEqual([{ provider: "mapbox", result: "unavailable" }]);
    // Only the provider name and status are logged, never the body, URL, or token.
    expect(logged).toEqual([[{ provider: "mapbox", status: 500 }, "Petunjuk penyedia gagal dimuat"]]);
    expect(await lookupHints(target, [provider])).toEqual([{ provider: "mapbox", result: "unavailable" }]);
    expect(failing.calls).toHaveLength(2);
    expect(await provider.lookup(target)).toEqual({ provider: "mapbox", result: "unavailable" });
    expect(failing.calls).toHaveLength(2);
  });
});

describe("Google hints", () => {
  const place = {
    id: "ChIJsiloam",
    displayName: { text: "Siloam Hospitals Bogor" },
    location: { latitude: -6.5957, longitude: 106.8047 },
    types: ["hospital", "health", "point_of_interest", "establishment"],
    googleMapsUri: "https://maps.google.com/?cid=1",
    accessibilityOptions: { wheelchairAccessibleEntrance: true, wheelchairAccessibleParking: false },
  };
  const google = (url: URL) => (url.pathname.endsWith(":searchText") ? json({ places: [{ ...place, id: "ChIJlain", displayName: { text: "Bogor Trade Mall" } }, place] }) : json(place));

  it("searches with the accessibility field mask, then keeps only the place id and fetches the details live", async () => {
    const { fetch, calls } = fakeFetch(google);
    const provider = googleHints({ apiKey: "kunci-google", now: () => new Date("2026-11-23T03:00:00Z"), fetch });
    const expected = {
      provider: "google",
      result: "found",
      placeName: "Siloam Hospitals Bogor",
      distanceMeters: 6,
      url: "https://maps.google.com/?cid=1",
      accessibility: { entrance: true, restroom: null, parking: false, seating: null },
    };
    expect(await provider.lookup(target)).toEqual(expected);
    const search = calls[0]!;
    expect(search.url.pathname).toBe("/v1/places:searchText");
    const headers = search.init!.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("kunci-google");
    expect(headers["x-goog-fieldmask"]).toBe("places.id,places.displayName,places.location,places.types,places.googleMapsUri,places.accessibilityOptions");
    expect(JSON.parse(String(search.init!.body))).toMatchObject({ textQuery: "RS Siloam Bogor", locationBias: { circle: { radius: 200 } } });

    // The second lookup calls Place Details again: accessibility content is never served from a cache.
    expect(await provider.lookup(target)).toEqual(expected);
    expect(calls.map((c) => c.url.pathname)).toEqual(["/v1/places:searchText", "/v1/places/ChIJsiloam"]);
    expect((calls[1]!.init!.headers as Record<string, string>)["x-goog-fieldmask"]).toBe("id,displayName,location,types,googleMapsUri,accessibilityOptions");
  });

  it("answers none for a place without accessibility options or without a match", async () => {
    const bare = fakeFetch(() => json({ places: [{ ...place, accessibilityOptions: undefined }] }));
    expect(await googleHints({ apiKey: "k", now: () => new Date(), fetch: bare.fetch }).lookup(target)).toEqual({ provider: "google", result: "none" });
    const far = fakeFetch(() => json({ places: [{ ...place, location: { latitude: -6.6, longitude: 106.8047 } }] }));
    const provider = googleHints({ apiKey: "k", now: () => new Date(), fetch: far.fetch });
    expect(await provider.lookup(target)).toEqual({ provider: "google", result: "none" });
    // "No match" is remembered, so the same lookup does not search again.
    await provider.lookup(target);
    expect(far.calls).toHaveLength(1);
  });
});
