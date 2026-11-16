// Menyimpan hasil Overpass ke basis pengetahuan (ADR-0042), dipotong ke batas Kota Bogor di tabel `districts`
// (ADR-0034). Dipakai `scripts/pengetahuan/osm.ts`.
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { osmFeatures, transitRoutes } from "../db/schema.js";
import { OSM_ATTRIBUTION, OSM_LICENSE, routePassage, type OsmFeatureRow, type TransitRouteRow, type TransitStop } from "./osm.js";
import { inBatches, insertPassages, replaceSource, type KnowledgeSource } from "./store.js";

export const OSM_SOURCE_ID = "osm-kota-bogor";
export const OSM_ROUTES_SOURCE_ID = "osm-rute-angkutan-kota-bogor";

type Download = { url: string; retrievedAt: Date; sha256: string };

const geoJson = (geometry: object) => sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geometry)}), 4326)`;
const kotaBogor = sql`(SELECT ST_Union(boundary) FROM districts)`;
const rowsOf = <T>(result: unknown) => (result as { rows: T[] }).rows;

/**
 * Mengganti fitur OSM dan rute angkutan dari satu unduhan Overpass. Fitur di luar Kota Bogor dibuang; garis rute
 * dipotong ke Kota Bogor, dan rute yang tidak menyentuh Kota Bogor dibuang. Mengembalikan jumlah baris yang tersimpan.
 */
export async function loadOsm(db: Db, data: { features: OsmFeatureRow[]; routes: TransitRouteRow[] }, download: Download) {
  const common = { url: download.url, license: OSM_LICENSE, attribution: OSM_ATTRIBUTION, retrievedAt: download.retrievedAt, sha256: download.sha256 };
  const osmSource: KnowledgeSource = { id: OSM_SOURCE_ID, kind: "osm", title: "Fitur aksesibilitas, tangga, lift, pintu masuk, dan halte di Kota Bogor (OpenStreetMap)", ...common };
  const routeSource: KnowledgeSource = { id: OSM_ROUTES_SOURCE_ID, kind: "angkutan_umum", title: "Rute bus dan angkot di Kota Bogor (OpenStreetMap)", ...common };

  await replaceSource(db, osmSource, async (tx) => {
    await inBatches(data.features, 200, (batch) =>
      tx.insert(osmFeatures).values(
        batch.map((f) => ({ osmType: f.osmType, osmId: f.osmId, sourceId: OSM_SOURCE_ID, kind: f.kind, name: f.name, tags: f.tags, geom: geoJson(f.geometry) })),
      ),
    );
    await tx.execute(sql`DELETE FROM osm_features WHERE source_id = ${OSM_SOURCE_ID} AND NOT ST_Intersects(geom, ${kotaBogor})`);
  });

  let routes = 0;
  await replaceSource(db, routeSource, async (tx) => {
    // Halte yang tersimpan sebagai fitur di Kota Bogor; halte rute di luar kota tidak ikut.
    const kept = new Set(
      rowsOf<{ key: string }>(await tx.execute(sql`SELECT osm_type || '/' || osm_id AS key FROM osm_features WHERE source_id = ${OSM_SOURCE_ID} AND kind = 'halte'`)).map(
        (r) => r.key,
      ),
    );
    const passages = [];
    for (const route of data.routes) {
      const stops: TransitStop[] = route.stops.filter((s) => kept.has(`${s.osmType}/${s.osmId}`));
      const streets = await streetsInKotaBogor(tx as unknown as Db, route.ways);
      const lines = route.ways.map((w) => w.coordinates);
      const geom = lines.length
        ? sql`(SELECT g FROM (SELECT ST_Multi(ST_CollectionExtract(ST_Intersection(${geoJson({ type: "MultiLineString", coordinates: lines })}, ${kotaBogor}), 2)) AS g) c WHERE NOT ST_IsEmpty(g))`
        : sql`NULL`;
      const [row] = await tx
        .insert(transitRoutes)
        .values({
          osmId: route.osmId,
          sourceId: OSM_ROUTES_SOURCE_ID,
          ref: route.ref,
          name: route.name,
          operator: route.operator,
          network: route.network,
          fromName: route.fromName,
          toName: route.toName,
          stops,
          geom,
        })
        .returning({ hasLine: sql<boolean>`${transitRoutes.geom} IS NOT NULL` });
      if (!row?.hasLine && stops.length === 0) {
        await tx.delete(transitRoutes).where(eq(transitRoutes.osmId, route.osmId));
        continue;
      }
      routes += 1;
      passages.push(routePassage({ ...route, stops }, streets));
    }
    await insertPassages(tx, OSM_ROUTES_SOURCE_ID, passages);
  });

  const [{ n: features } = { n: 0 }] = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM osm_features WHERE source_id = ${OSM_SOURCE_ID}`));
  return { features, routes };
}

/** Nama jalan yang dilewati di Kota Bogor, berurutan dan tanpa pengulangan. */
async function streetsInKotaBogor(db: Db, ways: TransitRouteRow["ways"]): Promise<string[]> {
  const named = ways.flatMap((w, seq) => (w.name ? [{ seq, name: w.name, geom: JSON.stringify({ type: "LineString", coordinates: w.coordinates }) }] : []));
  if (named.length === 0) return [];
  const rows = rowsOf<{ name: string }>(
    await db.execute(sql`
      SELECT w.name FROM jsonb_to_recordset(${JSON.stringify(named)}::jsonb) AS w(seq int, name text, geom text)
      WHERE ST_Intersects(ST_SetSRID(ST_GeomFromGeoJSON(w.geom), 4326), ${kotaBogor})
      GROUP BY w.name ORDER BY min(w.seq)`),
  );
  return rows.map((r) => r.name);
}
