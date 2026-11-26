// Jumlah penyandang disabilitas terdaftar per kecamatan dari Open Data Kota Bogor (ADR-0043). Angkanya dipakai untuk
// prioritas kecamatan bagi kontributor dan lapisan Persebaran disabilitas di Peta (ADR-0053), hanya selama
// `DISABILITY_DATA_ENABLED` menyala, karena syarat portal membatasi pemakaian untuk pihak ketiga tanpa izin Diskominfo.
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { disabilityCounts, type disabilityCategory } from "../db/schema.js";
import { replaceSource } from "../knowledge/store.js";

export type DisabilityCategory = (typeof disabilityCategory.enumValues)[number];

export const DISABILITY_SOURCE = {
  id: "opendata-kotabogor-disabilitas",
  title: "Jumlah Penyandang Disabilitas Berdasarkan Kecamatan dan Jenis Disabilitas di Kota Bogor",
  publisher: "Dinas Sosial Kota Bogor, lewat Open Data Kota Bogor",
  url: "https://opendata.kotabogor.go.id/api/bigdata/dinas_sosial/jmlh_pnyndng_dsblts_brdsrkn_kcmtn_jns_dsblts_d_kt_bgr?per_page=100",
  /** Ringkasan syarat portal; disimpan sebagai `license` di setiap sumber. */
  terms:
    "Syarat Open Data Kota Bogor: hak pakai non-komersial pribadi; pemakaian untuk kepentingan pihak ketiga perlu izin Diskominfo Kota Bogor",
} as const;

/** Kalimat yang selalu ikut setiap angka disabilitas, di API, jawaban agen, dan antarmuka. */
export const DISABILITY_CAVEAT =
  "Angka ini jumlah penyandang disabilitas yang terdaftar di Dinas Sosial Kota Bogor, bukan jumlah seluruh penyandang disabilitas. Jumlahnya melonjak besar antartahun, jadi angka antartahun belum bisa dibandingkan langsung.";

/** Label sumber ke jenis disabilitas AksesBogor. Kata "cacat" tidak dipakai di antarmuka (ADR-0041). */
const CATEGORY: Record<string, DisabilityCategory> = {
  "CACAT TUBUH": "fisik",
  "CACAT NETRA": "netra",
  "CACAT MENTAL": "mental",
  "CACAT LAINNYA": "lainnya",
};

export type DisabilityRow = { districtSlug: string; year: number; category: DisabilityCategory; sourceLabel: string; count: number };
type ApiRow = { bps_nama_kecamatan?: string; jenis_disabilitas?: string; jumlah?: number; tahun?: number };

/** Nama kecamatan sumber (mis. "TANAH SAREAL") menjadi slug AksesBogor ("tanah-sareal"). */
const slugOf = (name: string) => name.trim().toLowerCase().replace(/\s+/g, "-");

/**
 * Jawaban API portal menjadi baris tabel. Menolak seluruh isi bila ada kecamatan, jenis, atau angka yang tidak dikenal,
 * supaya perubahan format sumber tidak masuk diam-diam.
 */
export function parseDisabilityCounts(body: { data?: ApiRow[] }, districtSlugs: readonly string[]): DisabilityRow[] {
  const rows = body.data ?? [];
  if (rows.length === 0) throw new Error("Data disabilitas kosong");
  return rows.map((row, index) => {
    const districtSlug = slugOf(row.bps_nama_kecamatan ?? "");
    const sourceLabel = (row.jenis_disabilitas ?? "").trim();
    const category = CATEGORY[sourceLabel];
    if (!districtSlugs.includes(districtSlug)) throw new Error(`Baris ${index + 1}: kecamatan tidak dikenal "${row.bps_nama_kecamatan}"`);
    if (!category) throw new Error(`Baris ${index + 1}: jenis disabilitas tidak dikenal "${row.jenis_disabilitas}"`);
    if (!Number.isInteger(row.jumlah) || row.jumlah! < 0 || !Number.isInteger(row.tahun)) throw new Error(`Baris ${index + 1}: jumlah atau tahun tidak valid`);
    return { districtSlug, year: row.tahun!, category, sourceLabel, count: row.jumlah! };
  });
}

/** Mengganti seluruh data disabilitas dari satu kali ambil. */
export async function loadDisabilityCounts(db: Db, rows: readonly DisabilityRow[], raw: { retrievedAt: Date; sha256: string }) {
  const source = {
    id: DISABILITY_SOURCE.id,
    kind: "data_disabilitas" as const,
    title: DISABILITY_SOURCE.title,
    url: DISABILITY_SOURCE.url,
    license: DISABILITY_SOURCE.terms,
    attribution: DISABILITY_SOURCE.publisher,
    retrievedAt: raw.retrievedAt,
    sha256: raw.sha256,
  };
  await replaceSource(db, source, async (tx) => {
    await tx.insert(disabilityCounts).values(rows.map((r) => ({ ...r, sourceId: source.id })));
  });
  return rows.length;
}

const rowsOf = <T>(result: unknown) => (result as { rows: T[] }).rows;
/** Urutan jenis di jawaban API dan filter web. */
export const DISABILITY_CATEGORIES = ["fisik", "netra", "mental", "lainnya"] as const satisfies readonly DisabilityCategory[];

/**
 * Semua jumlah terdaftar per kecamatan, tahun, dan jenis, untuk lapisan Persebaran disabilitas di Peta (ADR-0053), atau
 * null bila data belum dimuat. Label sumber ("CACAT …") tidak ikut; kalimat batas data dan sumbernya selalu ikut.
 */
export async function disabilityByDistrict(db: Db) {
  const rows = rowsOf<{ slug: string; name: string; year: number | null; category: DisabilityCategory | null; count: number | null }>(
    await db.execute(sql`
      SELECT d.slug, d.name, c.year, c.category, c.count
      FROM districts d LEFT JOIN disability_counts c ON c.district_slug = d.slug AND c.source_id = ${DISABILITY_SOURCE.id}
      ORDER BY d.slug, c.year, c.category`),
  );
  const [source] = rowsOf<{ retrieved_at: Date | string }>(await db.execute(sql`SELECT retrieved_at FROM knowledge_sources WHERE id = ${DISABILITY_SOURCE.id}`));
  const years = [...new Set(rows.flatMap((r) => (r.year === null ? [] : [Number(r.year)])))].sort((a, b) => a - b);
  if (!source || years.length === 0) return null;
  const districts = new Map<string, { slug: string; name: string; counts: { year: number; category: DisabilityCategory; count: number }[] }>();
  for (const r of rows) {
    const district = districts.get(r.slug) ?? { slug: r.slug, name: r.name, counts: [] };
    districts.set(r.slug, district);
    if (r.year !== null && r.category !== null && r.count !== null) district.counts.push({ year: Number(r.year), category: r.category, count: Number(r.count) });
  }
  return {
    years,
    categories: [...DISABILITY_CATEGORIES],
    districts: [...districts.values()],
    caveat: DISABILITY_CAVEAT,
    source: {
      title: DISABILITY_SOURCE.title,
      url: DISABILITY_SOURCE.url,
      publisher: DISABILITY_SOURCE.publisher,
      retrievedAt: new Date(source.retrieved_at).toISOString(),
      terms: DISABILITY_SOURCE.terms,
    },
  };
}
