// Alat agen rute (ADR-0042) sebagai fungsi biasa: tidak ada model bahasa di sini. Route API di `src/routes/agent.ts`
// dan penyedia model memanggil fungsi yang sama lewat daftar di `src/agent/registry.ts`.
// Tidak ada alat yang menerima posisi pengguna atau mengembalikan rute: rute jalan kaki dan hambatan di dekatnya hanya
// untuk browser pengguna (`src/map/walking-route.ts`).
import type { Db } from "../db/client.js";
import { HttpError } from "../http/errors.js";
import { searchKnowledge, type KnowledgeHit, type KnowledgeKind } from "../knowledge/search.js";
import { getPlace, placesNamed } from "../places/queries.js";

export type ToolContext = {
  db: Db;
  now: () => Date;
};

/** find_place: lokasi AksesBogor yang sudah terbit dengan nama mirip, paling banyak 5. */
export async function findPlace(ctx: ToolContext, input: { query: string }) {
  return { places: await placesNamed(ctx.db, input.query, 5) };
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
