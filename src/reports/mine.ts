import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { photoTag, places, rejectionReason, reportKind, reportStatus, reports } from "../db/schema.js";
import { line, paragraph } from "./schemas.js";

export const myReports = z
  .object({
    items: z.array(
      z.object({
        id: z.uuid(),
        kind: z.enum(reportKind.enumValues).describe("baru, perubahan, atau kekurangan"),
        status: z.enum(reportStatus.enumValues).describe("menunggu (verifikasi), klarifikasi, diterbitkan, atau ditolak"),
        placeId: z.uuid().nullable().describe("Lokasi terkait; kosong untuk laporan tempat baru yang belum terbit"),
        placeName: z.string().nullable().describe("Nama lokasi terbit, atau nama dari isian laporan"),
        submittedAt: z.iso.datetime(),
        decidedAt: z.iso.datetime().nullable(),
        rejectionReason: z.enum(rejectionReason.enumValues).nullable().describe("Alasan baku R1 sampai R6 bila ditolak"),
        clarificationQuestion: z.string().nullable().describe("Pertanyaan verifikator bila statusnya klarifikasi"),
        clarificationDueAt: z.iso.datetime().nullable(),
      }),
    ),
  })
  .describe("Laporan saya");

const clarification = z.object({
  id: z.uuid(),
  question: z.string(),
  askedAt: z.iso.datetime(),
  dueAt: z.iso.datetime(),
  answer: z.string().nullable(),
  answeredAt: z.iso.datetime().nullable(),
});

export const myReport = z
  .object({
    id: z.uuid(),
    kind: z.enum(reportKind.enumValues),
    status: z.enum(reportStatus.enumValues),
    placeId: z.uuid().nullable(),
    placeName: z.string(),
    submittedAt: z.iso.datetime(),
    photos: z.number().int().describe("Jumlah foto laporan; jawaban klarifikasi boleh menambah sampai total 10"),
    clarifications: z.array(clarification).describe("Pertanyaan verifikator dan jawaban Anda, berurutan"),
  })
  .describe("Satu laporan saya dengan klarifikasinya");

export const clarificationBody = z.object({
  answer: paragraph(1000).describe("Jawaban untuk pertanyaan verifikator"),
  photos: z
    .array(z.object({ id: z.uuid().describe("Id dari `POST /reports/photos`"), tag: z.enum(photoTag.enumValues), caption: line(200).optional() }))
    .max(10)
    .default([])
    .refine((items) => new Set(items.map((p) => p.id)).size === items.length, "Foto tidak boleh dobel")
    .describe("Foto baru yang sudah diunggah akun ini; total foto laporan paling banyak 10"),
});

const iso = (value: Date | null) => (value ? new Date(value).toISOString() : null);

/** Laporan milik satu akun, terbaru dulu, paling banyak 100 (FR-14). */
export async function listMyReports(db: Db, userId: string): Promise<z.infer<typeof myReports>> {
  const rows = await db
    .select({
      id: reports.id,
      kind: reports.kind,
      status: reports.status,
      placeId: reports.placeId,
      // Laporkan menyimpan nama tempat di `submission.name`.
      placeName: sql<string | null>`coalesce(${places.name}, ${reports.submission}->>'name')`,
      submittedAt: reports.submittedAt,
      decidedAt: reports.decidedAt,
      rejectionReason: reports.rejectionReason,
      clarificationQuestion: reports.clarificationQuestion,
      clarificationDueAt: reports.clarificationDueAt,
    })
    .from(reports)
    .leftJoin(places, eq(places.id, reports.placeId))
    .where(eq(reports.reporterId, userId))
    .orderBy(desc(reports.submittedAt))
    .limit(100);
  return {
    items: rows.map((row) => ({
      ...row,
      submittedAt: new Date(row.submittedAt).toISOString(),
      decidedAt: iso(row.decidedAt),
      clarificationDueAt: iso(row.clarificationDueAt),
    })),
  };
}
