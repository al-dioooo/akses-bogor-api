// Jumlah penyandang disabilitas terdaftar per kecamatan dari Open Data Kota Bogor (ADR-0043). Angkanya hanya dipakai
// untuk menentukan kecamatan prioritas bagi kontributor, dan hanya selama `DISABILITY_DATA_ENABLED` menyala, karena
// syarat portal membatasi pemakaian untuk pihak ketiga tanpa izin Diskominfo.
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
