// Alat agen rute (ADR-0042) sebagai fungsi biasa: tidak ada model bahasa di sini. Route API di `src/routes/agent.ts`
// dan penyedia model memanggil fungsi yang sama lewat daftar di `src/agent/registry.ts`.
// Tidak ada alat yang menerima posisi pengguna atau mengembalikan rute: rute jalan kaki dan hambatan di dekatnya hanya
// untuk browser pengguna (`src/map/walking-route.ts`).
import { districtsByMissingData, placesWithoutData, type PlaceCategory } from "../contribute/facilities.js";
import { kecamatanPriority } from "../contribute/priority.js";
import type { Db } from "../db/client.js";
import { HttpError } from "../http/errors.js";
import { searchKnowledge, type KnowledgeHit, type KnowledgeKind } from "../knowledge/search.js";
import type { LatLng } from "../map/directions.js";
import { getPlace, placesNamed } from "../places/queries.js";

export type ToolContext = {
  db: Db;
  now: () => Date;
  /** `DISABILITY_DATA_ENABLED`: data disabilitas Open Data Kota Bogor boleh dipakai untuk prioritas kecamatan. */
  disabilityData?: boolean;
  /**
   * Titik awal pengunjung asisten rute publik (ADR-0050), dari browser atau titik yang dipilih di peta. Hanya dipakai
   * server, mis. untuk nearby_places; tidak pernah dikirim ke model.
   */
  position?: LatLng;
};

/** find_place: lokasi AksesBogor yang sudah terbit dengan nama mirip, paling banyak 5, tanpa koordinat. */
export async function findPlace(ctx: ToolContext, input: { query: string }) {
  const places = await placesNamed(ctx.db, input.query, 5);
  return { places: places.map((p) => ({ id: p.id, name: p.name, category: p.category, status: p.status, district: p.district })) };
}

/**
 * place_accessibility: jawaban fasilitas yang sudah diverifikasi, status, dan tanggal verifikasi terakhir. Koordinat
 * tempat tidak ikut: model tidak membutuhkannya, dan rute hanya ditampilkan aplikasi.
 */
export async function placeAccessibility(ctx: ToolContext, input: { placeId: string }) {
  const place = await getPlace(ctx.db, input.placeId, ctx.now());
  if (!place) throw new HttpError(404, "lokasi_tidak_ditemukan", "Lokasi tidak ditemukan.");
  return {
    id: place.id,
    name: place.name,
    category: place.category,
    district: place.district,
    landmark: place.landmark,
    description: place.description,
    status: place.status,
    summary: place.summary,
    because: place.because,
    facilities: place.facilities,
    lastVerifiedAt: place.lastVerifiedAt,
    needsRecheck: place.needsRecheck,
  };
}

/** search_knowledge: potongan teks regulasi, dokumen AksesBogor, dan rute angkutan dengan sumber dan sitasinya. */
export async function searchKnowledgeTool(ctx: ToolContext, input: { query: string; kinds?: KnowledgeKind[]; limit?: number }): Promise<{ passages: KnowledgeHit[] }> {
  return { passages: await searchKnowledge(ctx.db, input.query, { kinds: input.kinds, limit: input.limit }) };
}

const priorityClosed = () => new HttpError(503, "data_disabilitas_belum_aktif", "Data prioritas kecamatan belum dibuka.");

/** kecamatan_priority: skor prioritas kecamatan untuk kontributor (ADR-0043), selama data disabilitas boleh dipakai. */
export async function kecamatanPriorityTool(ctx: ToolContext) {
  if (!ctx.disabilityData) throw priorityClosed();
  const priority = await kecamatanPriority(ctx.db);
  if (!priority) throw new HttpError(503, "data_disabilitas_belum_dimuat", "Data prioritas kecamatan belum dimuat.");
  return priority;
}

/**
 * find_places_to_contribute: kampus, masjid, halte, dan rumah sakit dari OpenStreetMap yang belum punya data
 * AksesBogor, urut menurut prioritas kecamatan bila data disabilitas boleh dipakai, atau menurut jumlah tempat tanpa
 * data. Tanpa koordinat.
 */
export async function findPlacesToContribute(ctx: ToolContext, input: { kecamatan?: string; category?: PlaceCategory; limit?: number }) {
  const priority = ctx.disabilityData ? await kecamatanPriority(ctx.db) : null;
  const order = (priority?.districts ?? (await districtsByMissingData(ctx.db))).map((d) => d.slug);
  const places = await placesWithoutData(ctx.db, { district: input.kecamatan, category: input.category, limit: input.limit ?? 5, districtOrder: order });
  const rankOf = new Map(priority?.districts.map((d) => [d.slug, d.rank]) ?? []);
  return {
    places: places.map((p) => ({ ...p, priorityRank: rankOf.get(p.district.slug) ?? null })),
    order: priority ? "prioritas_kecamatan" : "tempat_tanpa_data_terbanyak",
    attribution: "© kontributor OpenStreetMap",
  };
}

