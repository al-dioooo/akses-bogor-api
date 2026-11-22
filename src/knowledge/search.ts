// Retrieval basis pengetahuan agen rute (ADR-0042) dengan full-text search PostgreSQL, tanpa penyedia embedding.
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { knowledgeKind } from "../db/schema.js";
import { SYNONYM_GROUPS } from "./sinonim.js";
import { stem } from "./stemmer.js";

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

/**
 * Kata umum bahasa Indonesia yang tidak membantu mencari. Konfigurasi `simple` tidak membuang kata apa pun. "belum"
 * sengaja tidak ada di sini karena "Belum tahu" adalah salah satu jawaban fasilitas AksesBogor (ADR-0017).
 */
const STOPWORDS = new Set(
  (
    "ada adalah agar akan aku anda apa apakah atau bagaimana bagi bahwa banyak beberapa begitu berapa bila bisa " +
    "boleh buat dalam dan dapat dari dengan di dia harus hingga ia ini itu jadi jika juga kalau kami kamu kan karena " +
    "ke kenapa kita lagi lain maka mana masih mau mengapa nya oleh pada para perlu saat saja saya sangat sebagai " +
    "sedang sejak seperti setelah siapa sudah supaya tapi tentang tetapi tidak untuk yaitu yang"
  ).split(" "),
);

const wordsOf = (text: string) => text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const searchable = (word: string) => !STOPWORDS.has(word) && (word.length > 1 || /\d/.test(word));

/** Kata dari pertanyaan: huruf kecil, hanya huruf dan angka, tanpa kata umum dan duplikat. */
export function queryTerms(query: string): string[] {
  return [...new Set(wordsOf(query).filter(searchable))].slice(0, MAX_TERMS);
}

/** Kata hanya berisi huruf dan angka, jadi aman disusun menjadi teks `tsquery`. */
const tsTerm = (term: string) => (term.length >= PREFIX_FROM && /^\p{L}+$/u.test(term) ? `${term}:*` : term);

/** Satu hal yang dicari: teks `tsquery` untuk kolom `search` (kata apa adanya) dan `search_stem` (bentuk dasar). */
export type Concept = { exact: string; stem: string };

/** Ungkapan di daftar padanan dalam bentuk dasar, yang terpanjang lebih dulu supaya "jalur pemandu" menang atas "jalur". */
const SYNONYMS = SYNONYM_GROUPS.flatMap((group) => group.map((phrase) => ({ group, stems: phrase.split(" ").map(stem) }))).sort(
  (a, b) => b.stems.length - a.stems.length,
);
const anyOf = (queries: readonly string[]) => queries.map((q) => `(${q})`).join(" | ");
const phraseQuery = (phrase: string, word: (w: string) => string) => phrase.split(" ").map(word).join(" <-> ");

/**
 * Hal-hal yang dicari dari pertanyaan. Ungkapan di daftar padanan (`sinonim.ts`, ADR-0044), dikenali dalam bentuk
 * dasarnya, menjadi satu hal beserta semua padanannya: "jalur landai" dicari sebagai ram, ramp, jalur landai, atau bidang
 * miring, dan ungkapan beberapa kata dicocokkan sebagai frasa. Kata lain menjadi satu hal masing-masing, tanpa kata
 * umum dan duplikat.
 */
export function queryConcepts(query: string): Concept[] {
  const words = wordsOf(query);
  const stems = words.map(stem);
  const concepts = new Map<string, Concept>();
  for (let i = 0; i < words.length; ) {
    const synonym = SYNONYMS.find((s) => s.stems.every((part, k) => stems[i + k] === part));
    if (synonym) {
      const { group } = synonym;
      concepts.set(group[0]!, { exact: anyOf(group.map((p) => phraseQuery(p, tsTerm))), stem: anyOf(group.map((p) => phraseQuery(p, stem))) });
      i += synonym.stems.length;
      continue;
    }
    const word = words[i]!;
    if (searchable(word)) concepts.set(word, { exact: tsTerm(word), stem: stems[i]! });
    i += 1;
  }
  return [...concepts.values()].slice(0, MAX_TERMS);
}

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
 * Pertanyaan dipecah menjadi hal-hal yang dicari (`queryConcepts`): kata, atau ungkapan beserta padanannya. Setiap hal
 * cocok bila ada apa adanya di kolom `search` (kata 4 huruf atau lebih sebagai awalan) atau dalam bentuk dasarnya di
 * kolom `search_stem` (ADR-0044), jadi "miring" juga menemukan "kemiringan" dan "WC" menemukan "toilet". Semuanya
 * digabung dengan OR, lalu diurutkan menurut jumlah hal yang cocok, kemudian rata-rata `ts_rank_cd` kedua kolom (selalu
 * di bawah 1, jadi hanya memisahkan potongan dengan jumlah hal cocok yang sama), dengan sitasi dan judul berbobot lebih
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

  const concepts = queryConcepts(query);
  const pairs = sql.join(
    concepts.map((c) => sql`(to_tsquery('simple', ${c.exact}), to_tsquery('simple', ${c.stem}))`),
    sql`, `,
  );
  const fullText = await db.execute(sql`
    WITH t(exact, stem) AS (VALUES ${pairs}),
      q AS (SELECT to_tsquery('simple', ${anyOf(concepts.map((c) => c.exact))}) AS exact, to_tsquery('simple', ${anyOf(concepts.map((c) => c.stem))}) AS stem)
    SELECT ${columns},
      (SELECT count(*) FROM t WHERE p.search @@ t.exact OR p.search_stem @@ t.stem)
        + (ts_rank_cd(p.search, q.exact, ${RANK_NORMALIZATION}) + ts_rank_cd(p.search_stem, q.stem, ${RANK_NORMALIZATION})) / 2 AS score
    FROM knowledge_passages p JOIN knowledge_sources s ON s.id = p.source_id, q
    WHERE (p.search @@ q.exact OR p.search_stem @@ q.stem) ${kindFilter}
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
