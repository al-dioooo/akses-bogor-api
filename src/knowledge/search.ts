// Retrieval basis pengetahuan agen rute (ADR-0042) dengan full-text search PostgreSQL, tanpa penyedia embedding.
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { knowledgeKind } from "../db/schema.js";

export type KnowledgeKind = (typeof knowledgeKind.enumValues)[number];

export type KnowledgeHit = {
  /** Rujukan untuk dikutip, mis. "UU No. 8 Tahun 2016, Pasal 18". */
  citation: string;
  heading: string | null;
  text: string;
  source: { id: string; kind: KnowledgeKind; title: string; url: string; license: string; attribution: string | null; retrievedAt: string };
  /** Makin besar makin cocok. Hanya untuk mengurutkan; skalanya bisa berubah. */
  score: number;
};

export const DEFAULT_PASSAGES = 5;
export const MAX_PASSAGES = 8;
/** Kata pertanyaan yang dipakai paling banyak; sisanya diabaikan. */
const MAX_TERMS = 12;
/** Kata dengan panjang ini atau lebih dicocokkan sebagai awalan, mis. "akses" juga cocok dengan "aksesibilitas". */
const PREFIX_FROM = 4;
/**
 * Normalisasi `ts_rank_cd` 32 (rank / (rank + 1)) menjaga nilainya di bawah 1. Tanpa itu, potongan panjang yang
 * mengulang satu kata bisa bernilai lebih dari 10 dan mengalahkan potongan yang cocok dengan lebih banyak kata.
 */
const RANK_NORMALIZATION = 32;

/** Kata umum bahasa Indonesia yang tidak membantu mencari. Konfigurasi `simple` tidak membuang kata apa pun. */
const STOPWORDS = new Set(
  (
    "ada adalah agar akan aku anda apa apakah atau bagaimana bagi bahwa banyak beberapa begitu belum berapa bila bisa " +
    "boleh buat dalam dan dapat dari dengan di dia harus hingga ia ini itu jadi jika juga kalau kami kamu kan karena " +
    "ke kenapa kita lagi lain maka mana masih mau mengapa nya oleh pada para perlu saat saja saya sangat sebagai " +
    "sedang sejak seperti setelah siapa sudah supaya tapi tentang tetapi tidak untuk yaitu yang"
  ).split(" "),
);

/** Kata dari pertanyaan: huruf kecil, hanya huruf dan angka, tanpa kata umum dan duplikat. */
export function queryTerms(query: string): string[] {
  const words = query.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms = words.filter((word) => !STOPWORDS.has(word) && (word.length > 1 || /\d/.test(word)));
  return [...new Set(terms)].slice(0, MAX_TERMS);
}

/** Kata hanya berisi huruf dan angka, jadi aman disusun menjadi teks `tsquery`. */
const tsTerm = (term: string) => (term.length >= PREFIX_FROM && /^\p{L}+$/u.test(term) ? `${term}:*` : term);

type Row = {
  citation: string;
  heading: string | null;
  body: string;
  source_id: string;
  kind: KnowledgeKind;
  title: string;
  url: string;
  license: string;
  attribution: string | null;
  retrieved_at: Date | string;
  score: number | string;
};

/** node-postgres dan PGlite sama-sama mengembalikan `{ rows }`; tipe `Db` yang umum tidak mengetahuinya. */
const rowsOf = (result: unknown) => (result as { rows: Row[] }).rows;

const toHit = (r: Row): KnowledgeHit => ({
  citation: r.citation,
  heading: r.heading,
  text: r.body,
  source: {
    id: r.source_id,
    kind: r.kind,
    title: r.title,
    url: r.url,
    license: r.license,
    attribution: r.attribution,
    retrievedAt: new Date(r.retrieved_at).toISOString(),
  },
  score: Math.round(Number(r.score) * 1000) / 1000,
});

/**
 * Potongan teks yang paling cocok dengan pertanyaan, beserta sumber, lisensi, dan sitasinya.
 *
 * Kata pertanyaan digabung dengan OR, lalu diurutkan menurut jumlah kata yang cocok, kemudian `ts_rank_cd` (selalu di
 * bawah 1, jadi hanya memisahkan potongan dengan jumlah kata cocok yang sama), dengan sitasi dan judul berbobot lebih
 * tinggi daripada isi. Bila tidak ada yang cocok sama sekali, misalnya karena salah ketik,
 * dipakai kemiripan kata `pg_trgm`.
 */
export async function searchKnowledge(db: Db, query: string, opts: { limit?: number; kinds?: KnowledgeKind[] } = {}): Promise<KnowledgeHit[]> {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_PASSAGES, 1), MAX_PASSAGES);
  const kinds = opts.kinds?.length ? opts.kinds : null;
  const list = (values: readonly string[]) => sql.join(values.map((value) => sql`${value}`), sql`, `);
  const kindFilter = kinds ? sql`AND s.kind::text IN (${list(kinds)})` : sql``;
  const columns = sql`p.citation, p.heading, p.body, s.id AS source_id, s.kind, s.title, s.url, s.license, s.attribution, s.retrieved_at`;

  const tsTerms = terms.map(tsTerm);
  const tsquery = tsTerms.join(" | ");
  const fullText = await db.execute(sql`
    WITH q AS (SELECT to_tsquery('simple', ${tsquery}) AS query)
    SELECT ${columns},
      (SELECT count(*) FROM unnest(ARRAY[${list(tsTerms)}]::text[]) AS t(term) WHERE p.search @@ to_tsquery('simple', t.term))
        + ts_rank_cd(p.search, q.query, ${RANK_NORMALIZATION}) AS score
    FROM knowledge_passages p JOIN knowledge_sources s ON s.id = p.source_id, q
    WHERE p.search @@ q.query ${kindFilter}
    ORDER BY score DESC, p.source_id, p.position
    LIMIT ${limit}`);
  if (rowsOf(fullText).length > 0) return rowsOf(fullText).map(toHit);

  const text = terms.join(" ");
  const fuzzy = await db.execute(sql`
    SELECT ${columns}, word_similarity(${text}, p.body) AS score
    FROM knowledge_passages p JOIN knowledge_sources s ON s.id = p.source_id
    WHERE ${text} <% p.body ${kindFilter}
    ORDER BY score DESC, p.source_id, p.position
    LIMIT ${limit}`);
  return rowsOf(fuzzy).map(toHit);
}
