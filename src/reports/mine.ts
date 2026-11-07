import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { places, rejectionReason, reportKind, reportStatus, reports } from "../db/schema.js";

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
