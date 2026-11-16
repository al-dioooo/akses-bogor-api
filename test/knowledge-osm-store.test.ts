import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client.js";
import { knowledgePassages, knowledgeSources, osmFeatures, transitRoutes } from "../src/db/schema.js";
import { parseOverpass } from "../src/knowledge/osm.js";
import { OSM_ROUTES_SOURCE_ID, OSM_SOURCE_ID, loadOsm } from "../src/knowledge/osm-store.js";
import { createTestDb } from "./helpers/db.js";
import { elements } from "./helpers/overpass.js";

describe("loadOsm", () => {
  let db: Db;
  let close: () => Promise<void>;
  const download = { url: "https://overpass-api.de/api/interpreter", retrievedAt: new Date("2026-11-16T04:00:00.000Z"), sha256: "a".repeat(64) };

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  }, 60_000);

  afterAll(async () => {
    await close();
  });

  it("stores features and routes inside Kota Bogor only", async () => {
    expect(await loadOsm(db, parseOverpass({ elements }), download)).toEqual({ features: 5, routes: 1 });
    const features = await db.select({ osmType: osmFeatures.osmType, osmId: osmFeatures.osmId }).from(osmFeatures).orderBy(osmFeatures.osmType, osmFeatures.osmId);
    expect(features.map((f) => `${f.osmType}/${f.osmId}`)).toEqual(["node/1", "node/3", "node/4", "relation/20", "way/10"]);

    const [route] = await db
      .select({ osmId: transitRoutes.osmId, stops: transitRoutes.stops, inside: sql<boolean>`ST_CoveredBy(${transitRoutes.geom}, (SELECT ST_Union(boundary) FROM districts))` })
      .from(transitRoutes);
    expect(route).toEqual({ osmId: 100, stops: [{ osmType: "node", osmId: 1, name: "Halte Kebun Raya" }], inside: true });

    const [passage] = await db.select().from(knowledgePassages).where(sql`${knowledgePassages.sourceId} = ${OSM_ROUTES_SOURCE_ID}`);
    expect(passage!.body).toContain("Jalan yang dilewati di Kota Bogor: Jalan Pajajaran.");
    expect(passage!.body).toContain("Halte di Kota Bogor, berurutan: Halte Kebun Raya.");
    expect(passage!.body).not.toContain("Medan Merdeka");
  });

  it("records the source, licence and retrieval date for both sources", async () => {
    const sources = await db.select().from(knowledgeSources).orderBy(knowledgeSources.id);
    expect(sources.map((s) => [s.id, s.kind, s.license, s.attribution, s.retrievedAt.toISOString(), s.sha256])).toEqual([
      [OSM_SOURCE_ID, "osm", "Open Database License (ODbL) 1.0", "© kontributor OpenStreetMap (https://www.openstreetmap.org/copyright)", "2026-11-16T04:00:00.000Z", "a".repeat(64)],
      [OSM_ROUTES_SOURCE_ID, "angkutan_umum", "Open Database License (ODbL) 1.0", "© kontributor OpenStreetMap (https://www.openstreetmap.org/copyright)", "2026-11-16T04:00:00.000Z", "a".repeat(64)],
    ]);
  });

  it("can run again without duplicates", async () => {
    expect(await loadOsm(db, parseOverpass({ elements }), { ...download, retrievedAt: new Date("2026-11-17T04:00:00.000Z") })).toEqual({ features: 5, routes: 1 });
    expect(await db.$count(knowledgePassages)).toBe(1);
    expect(await db.$count(osmFeatures)).toBe(5);
    expect(await db.$count(transitRoutes)).toBe(1);
  });
});
