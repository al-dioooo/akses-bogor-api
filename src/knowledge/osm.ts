// Data OpenStreetMap untuk agen rute (ADR-0042): kueri Overpass dan pengubah hasilnya menjadi baris tabel. Tidak
// menyentuh database, supaya mudah dites. Data © kontributor OpenStreetMap, berlisensi ODbL.
import type { osmFeatureKind } from "../db/schema.js";
import type { Passage } from "./store.js";

export type OsmFeatureKind = (typeof osmFeatureKind.enumValues)[number];
type LatLon = { lat: number; lon: number };

export type OverpassElement = {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: LatLon;
  geometry?: (LatLon | null)[];
  tags?: Record<string, string>;
  members?: { type: "node" | "way" | "relation"; ref: number; role: string; lat?: number; lon?: number; geometry?: (LatLon | null)[] }[];
};

/** Relasi OSM Kota Bogor (ADR-0034). Id area Overpass = 3600000000 + id relasi. */
export const KOTA_BOGOR_RELATION = 14745927;
export const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
export const OSM_LICENSE = "Open Database License (ODbL) 1.0";
/** Pedoman atribusi OSMF: sebut OpenStreetMap dan tautkan halaman hak cipta yang menjelaskan ODbL. */
export const OSM_ATTRIBUTION = "© kontributor OpenStreetMap (https://www.openstreetmap.org/copyright)";

/**
 * Satu kueri area untuk seluruh Kota Bogor, sesuai kebijakan pemakaian Overpass. Hasil tanpa `meta`, jadi tidak ada
 * nama penyunting, changeset, atau waktu sunting. Relasi bertag aksesibilitas (mis. gedung multipolygon) cukup titik
 * tengahnya; relasi rute bus diambil dengan geometri anggotanya, ditambah nama jalan yang dilewatinya.
 */
export const OVERPASS_QUERY = `[out:json][timeout:180];
area(id:${3_600_000_000 + KOTA_BOGOR_RELATION})->.kota;
(
  nwr(area.kota)["wheelchair"];
  nwr(area.kota)["toilets:wheelchair"];
  nwr(area.kota)["ramp"];
  nwr(area.kota)["ramp:wheelchair"];
  nwr(area.kota)["kerb"];
  nwr(area.kota)["tactile_paving"];
  way(area.kota)["highway"="steps"];
  nwr(area.kota)["highway"="elevator"];
  nwr(area.kota)["elevator"];
  nwr(area.kota)["entrance"][~"^(wheelchair|access|door|automatic_door|step_count|ramp|width)$"~"."];
  node(area.kota)["highway"="bus_stop"];
  nwr(area.kota)["public_transport"="platform"];
)->.fitur;
node.fitur;
out;
way.fitur;
out geom;
rel.fitur;
out tags center;
rel(area.kota)["route"="bus"]->.rute;
.rute out geom;
way(r.rute)["name"];
out tags;`;

/** Tag yang disimpan. Tag lain (kontak, situs, catatan bebas) dibuang supaya tidak ada data yang tidak perlu. */
const KEPT_TAGS = new Set([
  "name",
  "amenity",
  "building",
  "highway",
  "railway",
  "public_transport",
  "bus",
  "shelter",
  "bench",
  "route_ref",
  "ref",
  "wheelchair",
  "wheelchair:description",
  "wheelchair:description:id",
  "toilets:wheelchair",
  "ramp",
  "ramp:wheelchair",
  "ramp:stroller",
  "kerb",
  "kerb:height",
  "barrier",
  "crossing",
  "tactile_paving",
  "entrance",
  "door",
  "automatic_door",
  "width",
  "access",
  "step_count",
  "handrail",
  "handrail:left",
  "handrail:right",
  "incline",
  "surface",
  "elevator",
  "level",
]);

export function keptTags(tags: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(tags).filter(([key, value]) => KEPT_TAGS.has(key) && value.length <= 255));
}

/** Jenis fitur menurut prioritas: yang paling menentukan bagi pengguna kursi roda dan tunanetra lebih dulu. */
export function classify(tags: Record<string, string> = {}): OsmFeatureKind | null {
  if (tags.highway === "steps") return "tangga";
  if (tags.highway === "elevator" || (tags.elevator && tags.elevator !== "no")) return "lift";
  if (tags.entrance) return "pintu_masuk";
  if (tags.kerb || tags.barrier === "kerb") return "kerb";
  if (tags.ramp || tags["ramp:wheelchair"]) return "ramp";
  if (tags.tactile_paving) return "guiding_block";
  if (tags.highway === "bus_stop" || tags.public_transport === "platform") return "halte";
  if (tags.wheelchair || tags["toilets:wheelchair"]) return "tempat";
  return null;
}

export type GeoJsonGeometry = { type: "Point"; coordinates: [number, number] } | { type: "LineString"; coordinates: [number, number][] };

export type OsmFeatureRow = {
  osmType: OverpassElement["type"];
  osmId: number;
  kind: OsmFeatureKind;
  name: string | null;
  tags: Record<string, string>;
  geometry: GeoJsonGeometry;
};

const point = (p: LatLon): [number, number] => [p.lon, p.lat];
const linePoints = (geometry: (LatLon | null)[] = []) => geometry.filter((p): p is LatLon => p !== null).map(point);

function geometryOf(element: OverpassElement): GeoJsonGeometry | null {
  if (element.type === "node" && element.lat !== undefined && element.lon !== undefined) return { type: "Point", coordinates: point({ lat: element.lat, lon: element.lon }) };
  if (element.type === "way") {
    const coordinates = linePoints(element.geometry);
    if (coordinates.length >= 2) return { type: "LineString", coordinates };
    if (coordinates.length === 1) return { type: "Point", coordinates: coordinates[0]! };
  }
  if (element.center) return { type: "Point", coordinates: point(element.center) };
  return null;
}

/** Baris `osm_features` dari satu elemen Overpass, atau null bila bukan fitur yang dicari atau tanpa geometri. */
export function toFeatureRow(element: OverpassElement): OsmFeatureRow | null {
  if (element.tags?.route) return null;
  const kind = classify(element.tags);
  const geometry = geometryOf(element);
  if (!kind || !geometry) return null;
  const tags = keptTags(element.tags);
  return { osmType: element.type, osmId: element.id, kind, name: tags.name ?? null, tags, geometry };
}

export type TransitStop = { osmType: OverpassElement["type"]; osmId: number; name: string | null };

export type TransitRouteRow = {
  osmId: number;
  ref: string | null;
  name: string | null;
  operator: string | null;
  network: string | null;
  fromName: string | null;
  toName: string | null;
  via: string | null;
  /** Semua anggota halte dan platform, sebelum dipotong ke Kota Bogor. */
  stops: TransitStop[];
  /** Jalan yang dilewati, berurutan, sebelum dipotong ke Kota Bogor. */
  ways: { name: string | null; coordinates: [number, number][] }[];
};

const tag = (tags: Record<string, string> | undefined, key: string) => tags?.[key]?.slice(0, 200) || null;

/**
 * Baris `transit_routes` dari relasi `route=bus` (BisKita dan angkot sama-sama memakai tag ini). Nama halte dan nama
 * jalan diambil dari elemen lain di jawaban yang sama, dengan kunci "tipe/id".
 */
export function toTransitRoute(element: OverpassElement, names: ReadonlyMap<string, string>): TransitRouteRow | null {
  if (element.type !== "relation" || element.tags?.route !== "bus") return null;
  const stops: TransitStop[] = [];
  const ways: TransitRouteRow["ways"] = [];
  for (const member of element.members ?? []) {
    if (/^(stop|platform)/.test(member.role)) {
      const name = names.get(`${member.type}/${member.ref}`) ?? null;
      // Satu halte sering tercatat dua kali berurutan: titik henti di jalan dan platform di sampingnya.
      const previous = stops.at(-1);
      if (previous && name && previous.name === name) continue;
      stops.push({ osmType: member.type, osmId: member.ref, name });
    } else if (member.type === "way") {
      const coordinates = linePoints(member.geometry);
      if (coordinates.length >= 2) ways.push({ name: names.get(`way/${member.ref}`) ?? null, coordinates });
    }
  }
  const tags = element.tags;
  return {
    osmId: element.id,
    via: tag(tags, "via"),
    ref: tag(tags, "ref")?.slice(0, 40) ?? null,
    name: tag(tags, "name"),
    operator: tag(tags, "operator"),
    network: tag(tags, "network"),
    fromName: tag(tags, "from"),
    toName: tag(tags, "to"),
    stops,
    ways,
  };
}

/** Semua baris dari satu jawaban Overpass. Elemen yang sama bisa muncul lebih dari sekali; yang pertama dipakai. */
export function parseOverpass(body: { elements?: OverpassElement[] }) {
  const features = new Map<string, OsmFeatureRow>();
  for (const element of body.elements ?? []) {
    const row = toFeatureRow(element);
    if (row && !features.has(`${row.osmType}/${row.osmId}`)) features.set(`${row.osmType}/${row.osmId}`, row);
  }
  const names = new Map<string, string>();
  for (const element of body.elements ?? []) {
    const name = element.tags?.name;
    if (name && !element.tags?.route && !names.has(`${element.type}/${element.id}`)) names.set(`${element.type}/${element.id}`, name.slice(0, 200));
  }
  const routes = new Map<number, TransitRouteRow>();
  for (const element of body.elements ?? []) {
    const route = toTransitRoute(element, names);
    if (route && !routes.has(route.osmId)) routes.set(route.osmId, route);
  }
  return { features: [...features.values()], routes: [...routes.values()] };
}

const isAngkot = (text: string | null) => Boolean(text && /angkutan kota|angkot/i.test(text));

/** Judul rute, mis. "Angkutan Kota Bogor (angkot) 02: Sukasari–Bubulak" atau "BisKita Trans Pakuan K1: ...". */
export function routeTitle(route: Pick<TransitRouteRow, "osmId" | "ref" | "name" | "operator" | "network">) {
  const network = route.network ?? route.operator ?? "Rute bus";
  const label = `${network}${isAngkot(network) && !/angkot/i.test(network) ? " (angkot)" : ""}${route.ref ? ` ${route.ref}` : ""}`;
  return route.name ? `${label}: ${route.name}` : label;
}

type RouteSummary = Pick<TransitRouteRow, "osmId" | "ref" | "name" | "operator" | "network" | "fromName" | "toName" | "stops">;

/**
 * Potongan teks untuk satu rute bus atau angkot, supaya pertanyaan tentang angkutan umum bisa menemukannya. `streets`
 * dan `stops` sudah dipotong ke Kota Bogor oleh pemanggil.
 */
export function routePassage(route: RouteSummary & { via?: string | null }, streets: readonly string[]): Passage {
  const title = routeTitle(route);
  const named = route.stops.map((s) => s.name).filter((name): name is string => Boolean(name));
  const unnamed = route.stops.length - named.length;
  const sentences = [
    `${title}.`,
    route.operator && route.operator !== route.network ? `Operator: ${route.operator}.` : null,
    route.fromName || route.toName ? `Dari ${route.fromName ?? "?"} ke ${route.toName ?? "?"}${route.via ? `, lewat ${route.via}` : ""}.` : null,
    streets.length ? `Jalan yang dilewati di Kota Bogor: ${streets.join(", ")}.` : null,
    named.length
      ? `Halte di Kota Bogor, berurutan: ${named.join(", ")}.${unnamed ? ` Ada ${unnamed} titik henti lain tanpa nama.` : ""}`
      : route.stops.length
        ? `Ada ${route.stops.length} titik henti tanpa nama di Kota Bogor.`
        : "OpenStreetMap tidak mencatat halte untuk rute ini.",
  ];
  return { citation: `OpenStreetMap, relasi rute ${route.osmId}`, heading: title, body: sentences.filter(Boolean).join(" ") };
}
