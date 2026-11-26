// Daftar data yang belum diperiksa untuk verifikasi Street View (ADR-0057), dalam empat bentuk: salinan petunjuk di
// kandidat OSM, tempat yang diterbitkan langsung oleh admin, laporan yang menunggu, dan kandidat OSM yang tampil. Hanya
// membaca, di dalam transaksi read-only. Ada di modul petunjuk karena membaca salinan tersimpan (ADR-0052), dan seperti
// modul petunjuk lain tidak boleh dipakai alat agen atau asisten rute.
import { sql } from "drizzle-orm";
import { withoutAksesBogorData } from "../contribute/facilities.js";
import type { Db } from "../db/client.js";
import { GOOGLE_MAPS_TAG } from "./google-maps-import.js";
import { OSM_NOTE_TAG, record } from "./stored.js";

export const LIST_KINDS = ["petunjuk_google", "petunjuk_osm", "tempat_admin", "laporan", "kandidat"] as const;
export type ListKind = (typeof LIST_KINDS)[number];

export type ListRow = {
  jenis: ListKind;
  /** `node/123` untuk kandidat dan petunjuk, UUID untuk tempat dan laporan. */
  id: string;
  status: string;
  nama: string | null;
  kategori: string | null;
  kecamatan: string | null;
  lat: number | null;
  lng: number | null;
  klaim: string | null;
  /** Kandidat dan petunjuk: kandidatnya sedang tampil di lapisan "Belum ada data". */
  tayangDiPeta: boolean | null;
};

const rowsOf = <T>(result: unknown) => (result as { rows: T[] }).rows;
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** Salinan yang belum diperiksa: semua kecuali yang jelas ditandai sudah diperiksa (`belum_diperiksa_tim: false`). */
export const unchecked = (copy: Record<string, unknown> | null): copy is Record<string, unknown> => copy !== null && copy.belum_diperiksa_tim !== false;

/** Isi salinan Google dalam satu baris, mis. "ada: Pintu masuk …; tidak ada: Toilet …". */
export function googleClaim(copy: Record<string, unknown>) {
  const parts = [strings(copy.aksesibilitas).length ? `ada: ${strings(copy.aksesibilitas).join(", ")}` : "", strings(copy.tidak_tersedia).length ? `tidak ada: ${strings(copy.tidak_tersedia).join(", ")}` : ""];
  return parts.filter(Boolean).join("; ") || null;
}

/** Menjalankan `work` di transaksi read-only: setiap tulisan di dalamnya gagal. */
export function readOnly<T>(db: Db, work: (tx: Db) => Promise<T>) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    return work(tx);
  });
}

type OsmRow = { osm_type: string; osm_id: string | number; name: string | null; category: string; district: string; lat: number; lng: number; shown: boolean };

async function hintCopies(db: Db): Promise<ListRow[]> {
  const rows = rowsOf<OsmRow & { google: unknown; osm: unknown }>(
    await db.execute(sql`
      SELECT o.osm_type, o.osm_id, o.name, o.category, d.name AS district, ST_Y(o.location) AS lat, ST_X(o.location) AS lng,
        o.tags->${GOOGLE_MAPS_TAG} AS google, o.tags->${OSM_NOTE_TAG} AS osm, (${withoutAksesBogorData}) AS shown
      FROM osm_places o JOIN districts d ON d.slug = o.district_slug
      WHERE o.tags ? ${GOOGLE_MAPS_TAG} OR o.tags ? ${OSM_NOTE_TAG}
      ORDER BY o.osm_type, o.osm_id`),
  );
  const out: ListRow[] = [];
  for (const r of rows) {
    const base = { id: `${r.osm_type}/${r.osm_id}`, status: "belum_diperiksa_tim", nama: r.name, kategori: r.category, kecamatan: r.district, lat: Number(r.lat), lng: Number(r.lng), tayangDiPeta: r.shown };
    const google = record(r.google);
    const osm = record(r.osm);
    if (unchecked(google)) out.push({ ...base, jenis: "petunjuk_google", klaim: googleClaim(google) });
    if (unchecked(osm)) out.push({ ...base, jenis: "petunjuk_osm", klaim: typeof osm.wheelchair === "string" ? `wheelchair=${osm.wheelchair}` : null });
  }
  return out;
}

async function adminPlaces(db: Db): Promise<ListRow[]> {
  const rows = rowsOf<{ id: string; name: string; category: string; district: string; lat: number; lng: number; status: string; answers: string | null }>(
    await db.execute(sql`
      SELECT p.id, p.name, p.category, d.name AS district, ST_Y(p.location) AS lat, ST_X(p.location) AS lng, p.status,
        (SELECT string_agg(f.facility || '=' || f.answer, '; ' ORDER BY f.facility) FROM place_facilities f WHERE f.place_id = p.id) AS answers
      FROM places p JOIN districts d ON d.slug = p.district_slug
      WHERE p.admin_published_at IS NOT NULL AND p.unpublished_at IS NULL
      ORDER BY p.name, p.id`),
  );
  return rows.map((r) => ({ jenis: "tempat_admin", id: r.id, status: r.status, nama: r.name, kategori: r.category, kecamatan: r.district, lat: Number(r.lat), lng: Number(r.lng), klaim: r.answers, tayangDiPeta: null }));
}

/** Hanya id, jenis laporan, dan status: tanpa pelapor, nama tempat, titik, atau isian teks. */
async function pendingReports(db: Db): Promise<ListRow[]> {
  const rows = rowsOf<{ id: string; kind: string; status: string }>(
    await db.execute(sql`SELECT id, kind, status FROM reports WHERE status IN ('menunggu', 'klarifikasi') ORDER BY submitted_at, id`),
  );
  return rows.map((r) => ({ jenis: "laporan", id: r.id, status: r.status, nama: null, kategori: null, kecamatan: null, lat: null, lng: null, klaim: r.kind, tayangDiPeta: null }));
}

async function shownCandidates(db: Db): Promise<ListRow[]> {
  const rows = rowsOf<OsmRow & { wheelchair: string | null }>(
    await db.execute(sql`
      SELECT o.osm_type, o.osm_id, o.name, o.category, d.name AS district, ST_Y(o.location) AS lat, ST_X(o.location) AS lng, o.tags->>'wheelchair' AS wheelchair, true AS shown
      FROM osm_places o JOIN districts d ON d.slug = o.district_slug
      WHERE ${withoutAksesBogorData}
      ORDER BY o.osm_type, o.osm_id`),
  );
  return rows.map((r) => ({
    jenis: "kandidat",
    id: `${r.osm_type}/${r.osm_id}`,
    status: "tayang",
    nama: r.name,
    kategori: r.category,
    kecamatan: r.district,
    lat: Number(r.lat),
    lng: Number(r.lng),
    klaim: r.wheelchair ? `wheelchair=${r.wheelchair}` : null,
    tayangDiPeta: true,
  }));
}

/** Semua data yang belum diperiksa, dengan jumlah per jenis dan per jenis/status. */
export async function listUnverified(db: Db) {
  const rows = await readOnly(db, async (tx) => [...(await hintCopies(tx)), ...(await adminPlaces(tx)), ...(await pendingReports(tx)), ...(await shownCandidates(tx))]);
  const counts = new Map<string, number>(LIST_KINDS.map((kind) => [kind, 0]));
  for (const row of rows) {
    counts.set(row.jenis, counts.get(row.jenis)! + 1);
    counts.set(`${row.jenis}/${row.status}`, (counts.get(`${row.jenis}/${row.status}`) ?? 0) + 1);
  }
  return { rows, counts };
}

const COLUMNS = ["jenis", "id", "status", "nama", "kategori", "kecamatan", "lat", "lng", "klaim", "tayang_di_peta"] as const;
// Nama dari OSM ditulis siapa saja; sel teks yang diawali tanda rumus diberi petik supaya tidak dijalankan spreadsheet.
const text = (value: string | null) => (value === null ? "" : /^[=+\-@\t\r]/.test(value) ? `'${value}` : value);
const cell = (value: string) => (/[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

export function toCsv(rows: readonly ListRow[]) {
  const lines = rows.map((r) =>
    [r.jenis, r.id, r.status, text(r.nama), text(r.kategori), text(r.kecamatan), r.lat?.toFixed(7) ?? "", r.lng?.toFixed(7) ?? "", text(r.klaim), r.tayangDiPeta === null ? "" : String(r.tayangDiPeta)]
      .map(cell)
      .join(","),
  );
  return [COLUMNS.join(","), ...lines].join("\n") + "\n";
}
