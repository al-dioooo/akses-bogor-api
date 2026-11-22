// Menulis basis pengetahuan agen rute (ADR-0042). Hanya dipakai skrip di `scripts/pengetahuan/`.
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { knowledgePassages, knowledgeSources } from "../db/schema.js";
import { stemText } from "./stemmer.js";

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

/** Isi kolom `search_stem` (ADR-0044): bentuk dasar sitasi dan judul berbobot A, isi berbobot B, seperti kolom `search`. */
export const stemVector = (p: Passage) =>
  sql`setweight(to_tsvector('simple', ${stemText(`${p.citation} ${p.heading ?? ""}`)}), 'A') || setweight(to_tsvector('simple', ${stemText(p.body)}), 'B')`;

/** Menyimpan potongan teks sumber dengan urutan sesuai larik, beserta bentuk dasarnya untuk pencarian. */
export async function insertPassages(tx: Tx, sourceId: string, passages: readonly Passage[]) {
  const rows = passages.map((p, position) => ({ sourceId, position, citation: p.citation, heading: p.heading ?? null, body: p.body, searchStem: stemVector(p) }));
  await inBatches(rows, 200, (batch) => tx.insert(knowledgePassages).values(batch));
}

/**
 * Menghitung ulang `search_stem` semua potongan dalam satu transaksi, tanpa mengunduh atau memotong ulang sumbernya.
 * Dipakai setelah migrasi yang menambah kolom itu, dan setiap kali stemmer atau daftar kata dasarnya berubah.
 */
export async function reindexStems(db: Db): Promise<number> {
  const rows = await db
    .select({ id: knowledgePassages.id, citation: knowledgePassages.citation, heading: knowledgePassages.heading, body: knowledgePassages.body })
    .from(knowledgePassages);
  await db.transaction(async (tx) => {
    for (const row of rows) await tx.update(knowledgePassages).set({ searchStem: stemVector(row) }).where(eq(knowledgePassages.id, row.id));
  });
  return rows.length;
}
