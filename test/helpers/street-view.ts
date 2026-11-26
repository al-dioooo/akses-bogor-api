// Data uji verifikasi Street View (ADR-0057): data contoh, empat kandidat OSM dari uji 2026-11-26 dengan salinan
// petunjuk, satu tempat admin, dan laporan warga yang menunggu.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, eq, sql } from "drizzle-orm";
import { loadFacilities, parseFacilities } from "../../src/contribute/facilities.js";
import type { Db } from "../../src/db/client.js";
import type { OverpassElement } from "../../src/knowledge/osm.js";
import { places, reports, users } from "../../src/db/schema.js";
import { seedSampleData } from "../../src/db/seed.js";
import { createTestDb } from "./db.js";
import { png } from "./photos.js";

export type Ref = { type: "node" | "way"; id: number; lat: number; lng: number };
export const SILOAM: Ref = { type: "node", id: 4994301869, lat: -6.5955895, lng: 106.8049335 };
export const PMI: Ref = { type: "way", id: 782982224, lat: -6.598455, lng: 106.8060592 };
export const ATTAQWA: Ref = { type: "node", id: 14096317881, lat: -6.5439664, lng: 106.8133994 };
export const KESATUAN: Ref = { type: "way", id: 158830244, lat: -6.6064527, lng: 106.7991792 };
/** Kampus Kesatuan Gedung B, kandidat lain sekitar 32 m dari gedung STIE Kesatuan. Hanya dimuat bila diminta. */
export const KESATUAN_B: Ref = { type: "way", id: 304211992, lat: -6.606165, lng: 106.79919 };
export const ref = (r: Ref) => `${r.type}/${r.id}`;

const point = (r: Ref) => (r.type === "node" ? { lat: r.lat, lon: r.lng } : { center: { lat: r.lat, lon: r.lng } });
const ELEMENTS: OverpassElement[] = [
  { type: "node", id: SILOAM.id, ...point(SILOAM), tags: { amenity: "hospital", name: "Siloam Hospitals Bogor" } },
  { type: "way", id: PMI.id, ...point(PMI), tags: { amenity: "hospital", name: "RS PMI Bogor" } },
  { type: "node", id: ATTAQWA.id, ...point(ATTAQWA), tags: { amenity: "place_of_worship", religion: "muslim", name: "Masjid Attaqwa VBI", wheelchair: "limited" } },
  { type: "way", id: KESATUAN.id, ...point(KESATUAN), tags: { amenity: "college", name: "STIE Kesatuan Bogor", wheelchair: "no" } },
];
export const KESATUAN_B_ELEMENT: OverpassElement = { type: "way", id: KESATUAN_B.id, ...point(KESATUAN_B), tags: { amenity: "college", name: "Kampus Kesatuan Gedung B" } };

export const GOOGLE_COPY = {
  sumber: "Google Maps",
  nama: "Siloam Hospitals Bogor",
  url: "https://www.google.com/maps/place/?q=place_id:ChIJcontoh",
  place_id: "ChIJcontoh",
  aksesibilitas: ["Pintu masuk khusus pengguna kursi roda"],
  tidak_tersedia: ["Toilet khusus pengguna kursi roda"],
  diambil: "2026-11-23T03:00:00.000Z",
  metode: "apify:compass/crawler-google-places",
  jarak_titik_m: 28,
  belum_diperiksa_tim: true,
};
export const OSM_NOTE = { wheelchair: "yes", arti: "bisa dimasuki kursi roda" };
const GOOGLE = "aksesbogor:google_maps";
const NOTE = "aksesbogor:osm_aksesibilitas";

export async function streetViewRig(extra: OverpassElement[] = []) {
  const { db, close } = await createTestDb();
  await seedSampleData(db);
  await loadFacilities(db, parseFacilities({ elements: [...ELEMENTS, ...extra] }), { url: "https://overpass.contoh/api", retrievedAt: new Date("2026-11-22T00:00:00Z"), sha256: "0".repeat(64) });

  const tag = (r: Ref, key: string, value: unknown) =>
    db.execute(sql`UPDATE osm_places SET tags = tags || jsonb_build_object(${key}::text, ${JSON.stringify(value)}::jsonb) WHERE osm_type = ${r.type} AND osm_id = ${r.id}`);
  const tagsOf = async (r: Ref) => {
    const result = await db.execute(sql`SELECT tags FROM osm_places WHERE osm_type = ${r.type} AND osm_id = ${r.id}`);
    return (result as unknown as { rows: { tags: Record<string, unknown> }[] }).rows[0]!.tags;
  };
  await tag(SILOAM, GOOGLE, GOOGLE_COPY);
  await tag(PMI, GOOGLE, { ...GOOGLE_COPY, nama: "RS PMI Bogor" });
  await tag(PMI, NOTE, OSM_NOTE);
  await tag(ATTAQWA, NOTE, { wheelchair: "yes", arti: "bisa dimasuki kursi roda" });
  // Salinan yang sudah diperiksa tim tidak pernah dihitung atau diubah.
  await tag(KESATUAN, GOOGLE, { ...GOOGLE_COPY, nama: "IBI Kesatuan", belum_diperiksa_tim: false });

  const byName = async (name: string) => (await db.select({ id: places.id }).from(places).where(eq(places.name, name)))[0]!.id;
  const adminPlaceId = await byName("Rumah sakit contoh");
  await db.update(places).set({ adminPublishedAt: new Date("2026-11-24T03:00:00Z") }).where(eq(places.id, adminPlaceId));
  const teamPlaceId = await byName("Masjid contoh A");

  const [user] = await db.insert(users).values({ displayName: "Warga Bogor", email: "warga@contoh.id" }).returning({ id: users.id });
  await db.insert(reports).values([
    { kind: "baru", status: "menunggu", reporterId: user!.id, submission: { name: "Isian rahasia warga" } },
    { kind: "perubahan", status: "klarifikasi", placeId: teamPlaceId, reporterId: user!.id, submission: { description: "Teks bebas warga" }, clarificationQuestion: "Fotonya kurang jelas?" },
    { kind: "baru", status: "diterbitkan", placeId: teamPlaceId, reporterId: user!.id, submission: {} },
  ]);
  const allReports = () => db.select().from(reports).orderBy(asc(reports.id));

  return { db: db as Db, close, tag, tagsOf, adminPlaceId, teamPlaceId, allReports };
}

/** Folder sementara berisi PNG buatan untuk foto manifest. */
export async function imageDir(...names: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "street-view-"));
  for (const [i, name] of names.entries()) await writeFile(join(dir, name), await png(320 + i, 200));
  return dir;
}

const facility = (answer: string, reason?: string) => (reason ? { answer, reason } : { answer });

/** Data terjawab Siloam seperti uji 2026-11-26: pintu masuk rata, jadi ramp Tidak perlu. */
export const siloamSettled = (extra: Record<string, unknown> = {}) => ({
  record: "02",
  target: { osm: ref(SILOAM) },
  verdict: "settled",
  reason: "Pintu masuk kaca rata dengan tempat turun kendaraan, tanpa anak tangga.",
  place: { name: "Siloam Hospitals Bogor", category: "rumah_sakit", entrance: { lat: -6.5956638, lng: 106.8046881 } },
  facilities: { ramp: facility("tidak_perlu"), toilet_difabel: facility("belum_tahu"), guiding_block: facility("belum_tahu"), lift: facility("belum_tahu") },
  photos: [
    { file: "02-wide.png", kind: "wide", pano_id: "UFTHywLCN4qr8GgHaw8N5A", image_date: "2026-01", heading: 128 },
    { file: "02-close.png", kind: "close-up", pano_id: "UFTHywLCN4qr8GgHaw8N5A", image_date: "2026-01", heading: 128 },
  ],
  ...extra,
});

/** Data terjawab STIE Kesatuan: hanya tangga, tanpa ramp dan tanpa guiding block. */
export const kesatuanSettled = (extra: Record<string, unknown> = {}) => ({
  record: "10",
  target: { osm: ref(KESATUAN) },
  verdict: "settled",
  reason: "Pintu masuk utama hanya lewat tangga sekitar sepuluh anak tangga.",
  place: { name: "IBI Kesatuan", category: "kampus", entrance: { lat: -6.6062722, lng: 106.7994059 } },
  facilities: { ramp: facility("tidak_tersedia", "tidak_ada"), toilet_difabel: facility("belum_tahu"), guiding_block: facility("tidak_tersedia", "tidak_ada"), lift: facility("belum_tahu") },
  photos: [{ file: "10-close.png", kind: "close-up", pano_id: "Kesatuan", image_date: "2026-02", heading: 40 }],
  ...extra,
});

export const unsettled = (record: string, target: Record<string, string>, reason = "Pintu masuk tidak terlihat dari jalan.") => ({ record, target, verdict: "unsettled", reason });

export const manifestOf = (records: unknown[], round = "2026-11-27-uji") => ({ version: 1, round, generated_at: "2026-11-27T01:00:00Z", records });
