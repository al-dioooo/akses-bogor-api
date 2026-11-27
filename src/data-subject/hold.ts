// Menahan laporan atas permintaan pelapor (hak menunda atau membatasi pemrosesan, UU No. 27/2022 Pasal 40 dan 41).
// Laporan yang belum diputuskan (`menunggu` atau `klarifikasi`) diberi `held_at` dan alasan: tidak muncul di antrean,
// tidak bisa dibuka atau diputuskan verifikator, dan tidak ditolak otomatis karena tenggat klarifikasi. Laporan yang
// dikirim setelah penahanan tidak ikut ditahan. Saat dilepas, tenggat klarifikasi diperpanjang selama masa tahan,
// supaya pelapor tidak kehilangan waktu menjawab.
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { audit } from "../audit/log.js";
import type { Db } from "../db/client.js";
import { reportClarifications, reports } from "../db/schema.js";
import { HttpError } from "../http/errors.js";
import { REVIEWABLE } from "../verification/photos.js";

type Input = { userId: string; requestId: number; handler: { id: string }; now: Date };

export async function holdReports(db: Db, input: Input & { reason: string }) {
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) throw new HttpError(400, "alasan_wajib", "Alasan penahanan wajib diisi, paling banyak 500 karakter, tanpa data pribadi.");
  return db.transaction(async (tx) => {
    const held = await tx
      .update(reports)
      .set({ heldAt: input.now, holdReason: reason })
      .where(and(eq(reports.reporterId, input.userId), inArray(reports.status, [...REVIEWABLE]), isNull(reports.heldAt)))
      .returning({ id: reports.id });
    // Alasannya tidak masuk log audit, sama seperti catatan internal (ADR-0038).
    await audit(tx, ...held.map(({ id }) => ({ entity: "laporan" as const, entityId: id, actor: { userId: input.handler.id }, action: "laporan_ditahan", changes: { permintaan: input.requestId }, at: input.now })));
    return { held: held.length };
  });
}

export async function releaseReports(db: Db, input: Input) {
  return db.transaction(async (tx) => {
    const held = await tx
      .select({ id: reports.id, heldAt: reports.heldAt })
      .from(reports)
      .where(and(eq(reports.reporterId, input.userId), isNotNull(reports.heldAt)))
      .for("update");
    for (const { id, heldAt } of held) {
      const pause = sql`(${input.now.toISOString()}::timestamptz - ${heldAt!.toISOString()}::timestamptz)`;
      await tx
        .update(reports)
        .set({ heldAt: null, holdReason: null, clarificationDueAt: sql`${reports.clarificationDueAt} + ${pause}` })
        .where(eq(reports.id, id));
      await tx
        .update(reportClarifications)
        .set({ dueAt: sql`${reportClarifications.dueAt} + ${pause}` })
        .where(and(eq(reportClarifications.reportId, id), isNull(reportClarifications.answeredAt)));
    }
    await audit(tx, ...held.map(({ id }) => ({ entity: "laporan" as const, entityId: id, actor: { userId: input.handler.id }, action: "laporan_dilepas", changes: { permintaan: input.requestId }, at: input.now })));
    return { released: held.length };
  });
}
