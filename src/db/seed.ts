// Data contoh untuk pengembangan lokal dan tes. Nama tempat sengaja fiktif ("… contoh") supaya tidak ada status
// aksesibilitas yang melekat pada tempat nyata; kecamatannya nyata dan titiknya perkiraan di dalam kecamatan itu.
import type { Db } from "./client.js";
import { auditLog, districts, photos, placeFacilities, places, reports } from "./schema.js";
import { computeStatus, type FacilityAnswer } from "../domain/status.js";

export const DISTRICTS = [
  { slug: "bogor-barat", name: "Bogor Barat" },
  { slug: "bogor-selatan", name: "Bogor Selatan" },
  { slug: "bogor-tengah", name: "Bogor Tengah" },
  { slug: "bogor-timur", name: "Bogor Timur" },
  { slug: "bogor-utara", name: "Bogor Utara" },
  { slug: "tanah-sareal", name: "Tanah Sareal" },
] as const;

type SamplePlace = {
  name: string;
  category: (typeof places.category.enumValues)[number];
  districtSlug: (typeof DISTRICTS)[number]["slug"];
  lng: number;
  lat: number;
  landmark?: string;
  description?: string;
  lastVerifiedAt: string;
  facilities: (FacilityAnswer & { note?: string })[];
};

const all = (answer: "tersedia"): FacilityAnswer[] =>
  (["ramp", "toilet_difabel", "guiding_block", "lift"] as const).map((facility) => ({ facility, answer }));

export const SAMPLE_PLACES: SamplePlace[] = [
  {
    name: "Kampus contoh A", category: "kampus", districtSlug: "tanah-sareal", lng: 106.788, lat: -6.552,
    landmark: "Gerbang utara, dekat halte",
    description: "Ramp di pintu utama, toilet difabel di lantai dasar, guiding block dari gerbang, dan lift ke semua lantai.",
    lastVerifiedAt: "2026-10-10T03:00:00Z", facilities: all("tersedia"),
  },
  {
    name: "Halte contoh", category: "halte", districtSlug: "bogor-tengah", lng: 106.7942, lat: -6.5958,
    landmark: "Seberang gerbang barat Kebun Raya",
    description: "Halte contoh memiliki ramp dan lift, tetapi guiding block terputus sebelum pintu masuk.",
    lastVerifiedAt: "2026-10-18T03:00:00Z",
    facilities: [
      { facility: "ramp", answer: "tersedia" },
      { facility: "toilet_difabel", answer: "tidak_perlu", note: "Tidak ada toilet umum di halte ini" },
      { facility: "guiding_block", answer: "tidak_tersedia", reason: "tidak_sesuai", note: "Jalur terputus sebelum pintu masuk" },
      { facility: "lift", answer: "tersedia" },
    ],
  },
  {
    name: "Rumah sakit contoh", category: "rumah_sakit", districtSlug: "bogor-barat", lng: 106.764, lat: -6.57,
    landmark: "Pintu IGD di sisi selatan", lastVerifiedAt: "2026-09-28T03:00:00Z", facilities: all("tersedia"),
  },
  {
    name: "Kampus contoh B", category: "kampus", districtSlug: "bogor-utara", lng: 106.812, lat: -6.564,
    lastVerifiedAt: "2026-10-02T03:00:00Z",
    facilities: [
      { facility: "ramp", answer: "tersedia" },
      { facility: "toilet_difabel", answer: "tidak_tersedia", reason: "rusak", note: "Rusak sejak awal Oktober 2026" },
      { facility: "guiding_block", answer: "belum_tahu" },
      { facility: "lift", answer: "tersedia" },
    ],
  },
  {
    name: "Masjid contoh A", category: "masjid", districtSlug: "bogor-timur", lng: 106.813, lat: -6.605,
    lastVerifiedAt: "2026-08-15T03:00:00Z",
    facilities: [
      { facility: "ramp", answer: "tersedia" },
      { facility: "toilet_difabel", answer: "tersedia" },
      { facility: "guiding_block", answer: "tersedia" },
      { facility: "lift", answer: "tidak_perlu", note: "Semua ruang salat di lantai dasar" },
    ],
  },
  {
    name: "Masjid contoh B", category: "masjid", districtSlug: "bogor-selatan", lng: 106.8, lat: -6.63,
    lastVerifiedAt: "2026-07-20T03:00:00Z",
    facilities: [
      { facility: "ramp", answer: "tidak_tersedia", reason: "tidak_ada", note: "Pintu masuk hanya lewat lima anak tangga" },
      { facility: "toilet_difabel", answer: "tersedia" },
      { facility: "guiding_block", answer: "belum_tahu" },
      { facility: "lift", answer: "tidak_perlu" },
    ],
  },
  {
    // Diverifikasi lebih dari 12 bulan lalu, jadi ditandai perlu dicek ulang (FR-38).
    name: "Halte contoh B", category: "halte", districtSlug: "tanah-sareal", lng: 106.78, lat: -6.548,
    lastVerifiedAt: "2025-08-01T03:00:00Z",
    facilities: [
      { facility: "ramp", answer: "belum_tahu" },
      { facility: "toilet_difabel", answer: "tidak_perlu" },
      { facility: "guiding_block", answer: "belum_tahu" },
      { facility: "lift", answer: "tidak_perlu" },
    ],
  },
];

/** Mengosongkan data lokasi dan laporan, lalu mengisi kecamatan dan lokasi contoh. Hanya untuk pengembangan dan tes. */
export async function seedSampleData(db: Db) {
  await db.transaction(async (tx) => {
    for (const table of [auditLog, photos, reports, placeFacilities, places, districts]) await tx.delete(table);
    await tx.insert(districts).values([...DISTRICTS]);
    for (const p of SAMPLE_PLACES) {
      const s = computeStatus(p.facilities);
      const [row] = await tx
        .insert(places)
        .values({
          name: p.name, category: p.category, districtSlug: p.districtSlug, location: { x: p.lng, y: p.lat },
          landmark: p.landmark ?? null, description: p.description ?? null, status: s.status,
          facilitiesAvailable: s.available, facilitiesRelevant: s.relevant, facilitiesUnknown: s.unknown,
          lastVerifiedAt: new Date(p.lastVerifiedAt),
        })
        .returning({ id: places.id });
      await tx.insert(placeFacilities).values(
        p.facilities.map((f) => ({ placeId: row!.id, facility: f.facility, answer: f.answer, reason: f.reason ?? null, note: f.note ?? null })),
      );
    }
  });
  return { districts: DISTRICTS.length, places: SAMPLE_PLACES.length };
}
