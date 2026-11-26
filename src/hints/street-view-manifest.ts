// Manifest verifikasi Street View versi 1 (ADR-0057): hasil penilaian satu putaran, ditulis di host pekerja dan dibaca
// `pnpm verifikasi:street-view`. Bentuknya dijelaskan di runbook docs `operations/verifikasi-street-view.md`. Aturan
// penilaian ADR-0057 diperiksa di sini, sebelum transaksi dibuka.
import { z } from "zod";
import { facilityAnswer, placeCategory, unavailableReason } from "../db/schema.js";
import { FACILITIES, type Answer, type Facility, type Reason } from "../domain/status.js";

/** Gambar sebelum bulan ini diambil tetapi bukan bukti (ADR-0057). */
export const OLDEST_EVIDENCE_MONTH = "2022-01";
/** Foto yang dipasang per data; ADR-0023 membatasi sepuluh per laporan. */
export const MAX_PHOTOS = 4;

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "bulan gambar harus YYYY-MM");
const sentence = (max: number) => z.string().trim().min(5).max(max);

const facility = z.strictObject({
  answer: z.enum(facilityAnswer.enumValues),
  reason: z.enum(unavailableReason.enumValues).optional(),
  note: z.string().trim().min(1).max(200).optional(),
});

const photo = z.strictObject({
  file: z.string().min(1).max(300),
  kind: z.enum(["wide", "close-up", "other"]),
  pano_id: z.string().min(1).max(100),
  image_date: month,
  heading: z.number().min(0).max(360),
  tag: z.enum(["pintu_masuk", "guiding_block"]).default("pintu_masuk"),
  alt: sentence(200).optional(),
});

const target = z.union([
  z.strictObject({ osm: z.string().regex(/^(node|way|relation)\/\d+$/, "sasaran OSM ditulis seperti node/123") }),
  z.strictObject({ place_id: z.uuid() }),
]);

const common = {
  record: z.string().trim().min(1).max(20),
  target,
  reason: sentence(300),
  notes: z.record(z.string(), z.unknown()).optional(),
};

const settled = z.strictObject({
  ...common,
  verdict: z.literal("settled"),
  place: z.strictObject({
    name: z.string().trim().min(2).max(120),
    category: z.enum(placeCategory.enumValues),
    entrance: z.strictObject({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
    landmark: z.string().trim().min(1).max(140).optional(),
  }),
  facilities: z.strictObject({ ramp: facility, toilet_difabel: facility, guiding_block: facility, lift: facility }),
  photos: z.array(photo).min(1).max(MAX_PHOTOS),
});

const unsettled = z.strictObject({ ...common, verdict: z.literal("unsettled") });

export const manifestSchema = z.strictObject({
  version: z.literal(1),
  round: z.string().regex(/^[A-Za-z0-9._-]{1,60}$/, "nama putaran hanya huruf, angka, titik, garis bawah, atau tanda hubung"),
  generated_at: z.iso.datetime({ offset: true }).optional(),
  records: z.array(z.discriminatedUnion("verdict", [settled, unsettled])).min(1),
});

export type ManifestRecord = z.infer<typeof manifestSchema>["records"][number];
export type SettledRecord = Extract<ManifestRecord, { verdict: "settled" }>;
export type Target = { kind: "osm"; osmType: string; osmId: number } | { kind: "place"; placeId: string };
export type PlannedPhoto = SettledRecord["photos"][number];
export type FinalAnswer = { facility: Facility; answer: Answer; reason: Reason | null; note: string | null };

export type Manifest = {
  round: string;
  records: ({ record: string; target: Target; reason: string } & (
    | { verdict: "unsettled" }
    | { verdict: "settled"; place: SettledRecord["place"]; facilities: FinalAnswer[]; photos: PlannedPhoto[]; imageMonth: string }
  ))[];
};

export const targetKey = (t: Target) => (t.kind === "osm" ? `${t.osmType}/${t.osmId}` : t.placeId);

function toTarget(value: ManifestRecord["target"]): Target {
  if ("place_id" in value) return { kind: "place", placeId: value.place_id };
  const [osmType, id] = value.osm.split("/");
  return { kind: "osm", osmType: osmType!, osmId: Number(id) };
}

/** Pelanggaran aturan penilaian ADR-0057 pada satu data terjawab. */
export function judgementProblems(r: SettledRecord): string[] {
  const problems: string[] = [];
  const f = r.facilities;
  if (f.ramp.answer === "belum_tahu") problems.push("data terjawab butuh jawaban pintu masuk (ramp), bukan belum_tahu");
  if (f.toilet_difabel.answer !== "belum_tahu") problems.push("toilet_difabel selalu belum_tahu dari Street View");
  if (f.lift.answer !== "belum_tahu") problems.push("lift selalu belum_tahu dari Street View");
  for (const name of FACILITIES) {
    const item = f[name];
    if (item.answer === "tidak_tersedia" && !item.reason) problems.push(`${name} tidak_tersedia butuh reason`);
    if (item.answer !== "tidak_tersedia" && item.reason) problems.push(`${name}: reason hanya untuk tidak_tersedia`);
  }
  const tags = new Set(r.photos.map((p) => p.tag));
  if (["tersedia", "tidak_perlu"].includes(f.ramp.answer) && !tags.has("pintu_masuk")) problems.push("ramp tersedia atau tidak_perlu butuh foto bertag pintu_masuk");
  if (["tersedia", "tidak_perlu"].includes(f.guiding_block.answer) && !tags.has("guiding_block")) problems.push("guiding_block tersedia atau tidak_perlu butuh foto bertag guiding_block");
  for (const p of r.photos) if (p.image_date < OLDEST_EVIDENCE_MONTH) problems.push(`${p.file}: gambar ${p.image_date} lebih tua dari ${OLDEST_EVIDENCE_MONTH}, bukan bukti`);
  const files = r.photos.map((p) => p.file);
  if (new Set(files).size !== files.length) problems.push("berkas foto yang sama dipasang dua kali");
  return problems;
}

export class ManifestError extends Error {
  constructor(readonly problems: string[]) {
    super(`Manifest tidak valid:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  }
}

/** Membaca dan memeriksa manifest; galat menyebut semua masalah sekaligus, per nomor data. */
export function parseManifest(input: unknown): Manifest {
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success) throw new ManifestError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "(akar)"}: ${issue.message}`));
  const problems: string[] = [];
  const records: Manifest["records"] = [];
  const seenRecords = new Set<string>();
  const seenTargets = new Set<string>();
  for (const r of parsed.data.records) {
    const target = toTarget(r.target);
    const key = targetKey(target);
    if (seenRecords.has(r.record)) problems.push(`data ${r.record}: nomor data dipakai dua kali`);
    if (seenTargets.has(key)) problems.push(`data ${r.record}: sasaran ${key} sudah dipakai data lain`);
    seenRecords.add(r.record);
    seenTargets.add(key);
    if (r.verdict === "unsettled") {
      records.push({ record: r.record, target, reason: r.reason, verdict: "unsettled" });
      continue;
    }
    for (const problem of judgementProblems(r)) problems.push(`data ${r.record}: ${problem}`);
    const facilities = FACILITIES.map((name) => ({ facility: name, answer: r.facilities[name].answer, reason: r.facilities[name].reason ?? null, note: r.facilities[name].note ?? null }));
    // Bulan gambar tempat: gambar terlama yang dipasang, supaya label tidak terlihat lebih baru dari buktinya.
    const imageMonth = r.photos.map((p) => p.image_date).sort()[0]!;
    records.push({ record: r.record, target, reason: r.reason, verdict: "settled", place: r.place, facilities, photos: r.photos, imageMonth });
  }
  if (problems.length > 0) throw new ManifestError(problems);
  return { round: parsed.data.round, records };
}

const MONTHS = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

/** "2026-01" menjadi "Januari 2026". */
export const monthName = (yyyyMm: string) => `${MONTHS[Number(yyyyMm.slice(5, 7)) - 1]} ${yyyyMm.slice(0, 4)}`;

/** Teks alternatif bawaan foto Street View. */
export function photoAlt(p: PlannedPhoto, placeName: string) {
  if (p.alt) return p.alt;
  const subject = p.tag === "guiding_block" ? `Guiding block menuju pintu masuk ${placeName}` : `Pintu masuk ${placeName}`;
  const view = p.kind === "close-up" ? "dari dekat" : "dilihat dari jalan";
  return `${subject} ${view}, tangkapan Google Street View ${monthName(p.image_date)}`.slice(0, 200);
}

/** Keterangan foto: selalu menyebut Street View dan bulan gambarnya (ADR-0057). */
export const photoCaption = (p: PlannedPhoto) => `Sumber: Google Street View, gambar ${monthName(p.image_date)}`;
