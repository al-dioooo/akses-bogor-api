// Mengirim laporan ke antrean verifikasi (FR-20 sampai FR-27, ADR-0006, ADR-0033). Laporan tidak mengubah data lokasi;
// isian disimpan apa adanya di `submission` sampai verifikator menerbitkannya.
import { and, count, eq, gt, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { districts, photos, places, reports } from "../db/schema.js";
import { HttpError } from "../http/errors.js";
import { requireDistrict } from "./location.js";
import type { ReportBody } from "./schemas.js";

/** Laporan per akun dalam 24 jam (ADR-0033). */
export const REPORTS_PER_DAY = 20;
/** Laporan per akun yang boleh menunggu verifikasi atau klarifikasi sekaligus (ADR-0033). */
export const WAITING_REPORTS = 30;

type PhotoTag = ReportBody["photos"][number]["tag"];

const TAG_LABEL: Record<PhotoTag, string> = {
  pintu_masuk: "pintu masuk dan ramp",
  toilet_difabel: "toilet difabel",
  guiding_block: "guiding block",
  lift: "lift",
  lainnya: "",
};

/** Teks alternatif dari tag dan nama tempat (ADR-0023), mis. "Foto pintu masuk dan ramp, Halte contoh". */
export const altText = (tag: PhotoTag, placeName: string) => (TAG_LABEL[tag] ? `Foto ${TAG_LABEL[tag]}, ${placeName}` : `Foto ${placeName}`).slice(0, 200);

const iso = (date: Date) => new Date(date).toISOString();

async function existing(db: Db, reporterId: string, submissionKey: string) {
  const [row] = await db
    .select({
      id: reports.id,
      kind: reports.kind,
      status: reports.status,
      placeId: reports.placeId,
      submission: reports.submission,
      districtSlug: districts.slug,
      districtName: districts.name,
      submittedAt: reports.submittedAt,
    })
    .from(reports)
    .innerJoin(districts, eq(districts.slug, reports.districtSlug))
    .where(and(eq(reports.reporterId, reporterId), eq(reports.submissionKey, submissionKey)));
  if (!row) return null;
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(photos).where(eq(photos.reportId, row.id));
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    placeId: row.placeId,
    name: (row.submission as { name: string }).name,
    district: { slug: row.districtSlug, name: row.districtName },
    photos: n,
    submittedAt: iso(row.submittedAt),
  };
}

/** Batas per akun: 20 laporan per 24 jam dan 30 laporan yang masih menunggu. */
async function checkLimits(db: Db, reporterId: string, now: Date) {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [[recent], [waiting]] = await Promise.all([
    db.select({ n: count() }).from(reports).where(and(eq(reports.reporterId, reporterId), gt(reports.submittedAt, since))),
    db.select({ n: count() }).from(reports).where(and(eq(reports.reporterId, reporterId), inArray(reports.status, ["menunggu", "klarifikasi"]))),
  ]);
  if ((recent?.n ?? 0) >= REPORTS_PER_DAY) {
    throw new HttpError(429, "laporan_terlalu_sering", `Anda sudah mengirim ${REPORTS_PER_DAY} laporan dalam 24 jam terakhir. Draf tetap tersimpan; coba kirim lagi besok.`);
  }
  if ((waiting?.n ?? 0) >= WAITING_REPORTS) {
    throw new HttpError(429, "antrean_penuh", `Ada ${WAITING_REPORTS} laporan Anda yang masih menunggu verifikasi. Draf tetap tersimpan; coba kirim lagi setelah sebagian diputuskan.`);
  }
}

/**
 * Menyimpan laporan dengan status menunggu. Kecamatan dihitung ulang dari titik (FR-22), lokasi terkait harus ada
 * untuk perubahan dan kekurangan (FR-27), dan foto yang diunggah akun ini dipasang beserta tag, keterangan, dan teks
 * alternatifnya. `created` salah berarti laporan dengan kunci draf yang sama sudah ada dan dikembalikan apa adanya.
 */
export async function submitReport(db: Db, reporterId: string, body: ReportBody, now: Date) {
  const repeat = await existing(db, reporterId, body.submissionKey);
  if (repeat) return { report: repeat, created: false };
  await checkLimits(db, reporterId, now);

  let place: { name: string; category: NonNullable<ReportBody["category"]>; location: { lat: number; lng: number }; landmark: string | null } | null = null;
  if (body.placeId) {
    const [row] = await db
      .select({ name: places.name, category: places.category, location: places.location, landmark: places.landmark })
      .from(places)
      .where(eq(places.id, body.placeId));
    if (!row) throw new HttpError(404, "lokasi_tidak_ditemukan", "Lokasi ini tidak ditemukan. Mungkin sudah dihapus; laporkan sebagai tempat baru.");
    place = { ...row, location: { lat: row.location.y, lng: row.location.x } };
  }
  // Laporan kekurangan tidak mengubah nama, kategori, dan titik (ADR-0033).
  const fixed = body.kind === "kekurangan" ? place! : null;
  const name = fixed?.name ?? body.name!;
  const category = fixed?.category ?? body.category!;
  const location = fixed?.location ?? body.location!;
  const landmark = fixed ? fixed.landmark : (body.landmark ?? null);
  const district = await requireDistrict(db, location);

  const insert = () => db.transaction(async (tx) => {
    const [row] = await tx
      .insert(reports)
      .values({
        reporterId,
        kind: body.kind,
        placeId: body.placeId ?? null,
        status: "menunggu",
        submission: {
          versi: 1,
          name,
          category,
          landmark,
          description: body.description ?? null,
          facilities: body.facilities.map((f) => ({ facility: f.facility, answer: f.answer, reason: f.reason ?? null, note: f.note ?? null })),
        },
        location: { x: location.lng, y: location.lat },
        districtSlug: district.slug,
        submissionKey: body.submissionKey,
        submittedAt: now,
      })
      .returning({ id: reports.id, submittedAt: reports.submittedAt });
    for (const photo of body.photos) {
      const attached = await tx
        .update(photos)
        .set({ reportId: row!.id, uploaderId: null, tag: photo.tag, caption: photo.caption ?? null, altText: altText(photo.tag, name) })
        .where(and(eq(photos.id, photo.id), eq(photos.uploaderId, reporterId), isNull(photos.reportId)))
        .returning({ id: photos.id });
      if (attached.length === 0) {
        throw new HttpError(400, "foto_tidak_ditemukan", "Sebagian foto sudah tidak tersimpan di server. Unggah ulang fotonya, lalu kirim lagi.");
      }
    }
    return row!;
  });
  let report: Awaited<ReturnType<typeof insert>>;
  try {
    report = await insert();
  } catch (error) {
    // Dua kiriman dengan kunci draf yang sama pada saat bersamaan: yang kalah mengembalikan laporan yang menang.
    const code = (error as { code?: string; cause?: { code?: string } }).code ?? (error as { cause?: { code?: string } }).cause?.code;
    const winner = code === "23505" ? await existing(db, reporterId, body.submissionKey) : null;
    if (winner) return { report: winner, created: false };
    throw error;
  }

  return {
    created: true,
    report: {
      id: report.id,
      kind: body.kind,
      status: "menunggu" as const,
      placeId: body.placeId ?? null,
      name,
      district,
      photos: body.photos.length,
      submittedAt: iso(report.submittedAt),
    },
  };
}
