// Menulis basis pengetahuan agen rute (ADR-0042). Hanya dipakai skrip di `scripts/pengetahuan/`.
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { knowledgePassages, knowledgeSources } from "../db/schema.js";

export type KnowledgeSource = typeof knowledgeSources.$inferInsert;
export type Passage = { citation: string; heading?: string | null; body: string };
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Baris disisipkan per kelompok supaya jumlah parameter per query tetap kecil. */
export async function inBatches<T>(rows: readonly T[], size: number, insert: (batch: T[]) => Promise<unknown>) {
  for (let start = 0; start < rows.length; start += size) await insert(rows.slice(start, start + size));
}

/**
 * Mengganti satu sumber beserta semua barisnya dalam satu transaksi, jadi skrip bisa dijalankan ulang tanpa duplikat dan
 * tanpa sisa baris lama. Bila `fill` gagal, data lama tetap utuh.
 */
export async function replaceSource(db: Db, source: KnowledgeSource, fill: (tx: Tx) => Promise<void>) {
  await db.transaction(async (tx) => {
    await tx.delete(knowledgeSources).where(eq(knowledgeSources.id, source.id));
    await tx.insert(knowledgeSources).values(source);
    await fill(tx);
  });
}

/** Menyimpan potongan teks sumber dengan urutan sesuai larik. */
export async function insertPassages(tx: Tx, sourceId: string, passages: readonly Passage[]) {
  const rows = passages.map((p, position) => ({ sourceId, position, citation: p.citation, heading: p.heading ?? null, body: p.body }));
  await inBatches(rows, 200, (batch) => tx.insert(knowledgePassages).values(batch));
}
