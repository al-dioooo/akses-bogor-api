import { describe, expect, it, vi } from "vitest";
import { DirectionsQuotaError, NoRouteError, mapboxWalking } from "../src/map/directions.js";

const now = () => new Date("2026-11-16T05:00:00.000Z");
const from = { lat: -6.5965, lng: 106.7972 };
const to = { lat: -6.5958, lng: 106.7942 };

const answer = () =>
  Response.json({
    code: "Ok",
    routes: [
      {
        distance: 412.6,
        duration: 301.2,
        geometry: { type: "LineString", coordinates: [[106.7972, -6.5965], [106.7955, -6.596], [106.7942, -6.5958]] },
        legs: [
          {
            steps: [
              { distance: 300.4, duration: 220.1, name: "Jalan Pajajaran", maneuver: { type: "depart", instruction: "Berjalan ke barat di Jalan Pajajaran", location: [106.7972, -6.5965] } },
              { distance: 112.2, duration: 81.1, name: "", maneuver: { type: "arrive", instruction: "Anda telah tiba", location: [106.7942, -6.5958] } },
            ],
          },
        ],
      },
    ],
  });

describe("mapboxWalking", () => {
  it("asks the walking profile for one route with steps in Indonesian", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => answer());
    const route = await mapboxWalking({ token: "sk.rahasia", now, fetch })(from, to);
    const url = new URL(String(fetch.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe("https://api.mapbox.com/directions/v5/mapbox/walking/106.7972,-6.5965;106.7942,-6.5958");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      access_token: "sk.rahasia",
      alternatives: "false",
      geometries: "geojson",
      overview: "full",
      steps: "true",
      language: "id",
    });
    expect(route).toEqual({
      distanceMeters: 413,
      durationSeconds: 301,
      steps: [
        { instruction: "Berjalan ke barat di Jalan Pajajaran", distanceMeters: 300, durationSeconds: 220, name: "Jalan Pajajaran", maneuver: "depart", location: { lat: -6.5965, lng: 106.7972 } },
        { instruction: "Anda telah tiba", distanceMeters: 112, durationSeconds: 81, name: null, maneuver: "arrive", location: { lat: -6.5958, lng: 106.7942 } },
      ],
      geometry: { type: "LineString", coordinates: [[106.7972, -6.5965], [106.7955, -6.596], [106.7942, -6.5958]] },
    });
  });

  it("reports when Mapbox finds no walking route", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ code: "NoRoute", routes: [] }, { status: 200 }));
    await expect(mapboxWalking({ token: "sk.rahasia", now, fetch })(from, to)).rejects.toBeInstanceOf(NoRouteError);
  });

  it("never puts the token in error messages", async () => {
    const offline = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError("fetch failed: https://api.mapbox.com/...?access_token=sk.rahasia");
    });
    await expect(mapboxWalking({ token: "sk.rahasia", now, fetch: offline })(from, to)).rejects.toThrow(/^Mapbox Directions tidak bisa dihubungi$/);
    const refused = vi.fn<typeof globalThis.fetch>(async () => Response.json({ code: "InvalidToken", message: "Not Authorized" }, { status: 401 }));
    const error = await mapboxWalking({ token: "sk.rahasia", now, fetch: refused })(from, to).catch((e: Error) => e);
    expect(String(error)).not.toContain("sk.rahasia");
  });

  it("stops at the daily limit and starts again after midnight WIB", async () => {
    let clock = new Date("2026-11-16T16:59:00.000Z");
    const fetch = vi.fn<typeof globalThis.fetch>(async () => answer());
    const route = mapboxWalking({ token: "sk.rahasia", now: () => clock, fetch, perDay: 1 });
    await route(from, to);
    await expect(route(from, to)).rejects.toBeInstanceOf(DirectionsQuotaError);
    clock = new Date("2026-11-16T17:00:00.000Z");
    await expect(route(from, to)).resolves.toMatchObject({ distanceMeters: 413 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
