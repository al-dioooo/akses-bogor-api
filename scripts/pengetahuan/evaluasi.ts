// Mengukur retrieval `search_knowledge` (ADR-0042) tanpa model: setiap pertanyaan di `uji-retrieval.json` dicari dengan
// `searchKnowledge`, lalu dihitung recall@3, recall@5 (jumlah bawaan alat), recall@8 (batas alat), dan MRR terhadap
// sitasi yang harus ditemukan. Butuh basis pengetahuan yang sudah dimuat (`pnpm pengetahuan:regulasi`, `:dokumen`, dan
// `:osm`, boleh dengan `--salinan`). Hanya membaca database dan tidak memanggil layanan luar.
//
//   pnpm pengetahuan:evaluasi                    semua pertanyaan
//   pnpm pengetahuan:evaluasi R01 R07            hanya pertanyaan tertentu
//   pnpm pengetahuan:evaluasi --terpisah         set terpisah `uji-retrieval-terpisah.json`, untuk memeriksa bahwa
//                                                perubahan tidak hanya cocok untuk set utama; jangan menyetel dari set ini
//   pnpm pengetahuan:evaluasi --rinci            juga mencetak 8 sitasi teratas setiap pertanyaan
//   pnpm pengetahuan:evaluasi --json hasil.json  juga menulis hasil per pertanyaan ke berkas JSON
import { readFileSync, writeFileSync } from "node:fs";
import { loadEnv } from "../../src/config/env.js";
import { createDb } from "../../src/db/client.js";
import { MAX_PASSAGES, searchKnowledge } from "../../src/knowledge/search.js";
import { averageScores, scoreQuestion, type QuestionScore, type Target } from "./metrik-retrieval.js";

type Question = { id: string; jenis: string; pertanyaan: string; relevan: Target[] };

const KS = [3, 5, MAX_PASSAGES];

const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const jsonPath = option("--json");
const separate = args.includes("--terpisah");
const detailed = args.includes("--rinci");
const wanted = args.filter((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--json");

const file = separate ? "./uji-retrieval-terpisah.json" : "./uji-retrieval.json";
const all = JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8")) as Question[];
const questions = wanted.length > 0 ? all.filter((q) => wanted.includes(q.id)) : all;

const env = loadEnv();
const { db, pool } = createDb(env.DATABASE_URL);

const pct = (value: number) => `${Math.round(value * 100)}%`.padStart(4);
const short = (citation: string) => citation.replace("Permen PUPR No. 14/PRT/M/2017, ", "Permen, ").replace("UU No. 8 Tahun 2016, ", "UU 8/2016, ").slice(0, 70);

const results: (QuestionScore & { id: string; jenis: string; pertanyaan: string; citations: string[] })[] = [];
console.log(`id   ${KS.map((k) => `R@${k}`.padStart(4)).join(" ")}   RR  pertama  pertanyaan`);
for (const q of questions) {
  const hits = await searchKnowledge(db, q.pertanyaan, { limit: MAX_PASSAGES });
  const citations = hits.map((h) => h.citation);
  const score = scoreQuestion(citations, q.relevan, KS);
  results.push({ id: q.id, jenis: q.jenis, pertanyaan: q.pertanyaan, ...score, citations });
  const rank = score.firstRank === null ? "-" : String(score.firstRank);
  console.log(`${q.id}  ${KS.map((k) => pct(score.recall[k] ?? 0)).join(" ")}  ${score.reciprocalRank.toFixed(2)}  ${rank.padStart(7)}  ${q.pertanyaan}`);
  if (detailed || (score.recall[3] ?? 0) < 1) {
    const top = detailed ? citations : citations.slice(0, 3);
    console.log(top.map((c, i) => `       ${i + 1}. ${short(c)}`).join("\n") || "       (tidak ada hasil)");
  }
}
await pool.end();

const summarize = (label: string, rows: typeof results) => {
  const avg = averageScores(rows, KS);
  console.log(`${label.padEnd(14)} ${String(rows.length).padStart(3)}  ${KS.map((k) => pct(avg.recall[k] ?? 0)).join(" ")}  ${avg.mrr.toFixed(3)}`);
};
console.log(`\nkelompok         n  ${KS.map((k) => `R@${k}`.padStart(4)).join(" ")}  MRR`);
summarize("semua", results);
for (const tag of ["imbuhan", "sinonim", "salah ketik"]) {
  const rows = results.filter((r) => r.jenis.split(", ").includes(tag));
  if (rows.length > 0) summarize(tag, rows);
}

if (jsonPath) {
  writeFileSync(jsonPath, `${JSON.stringify({ ks: KS, ...averageScores(results, KS), pertanyaan: results }, null, 2)}\n`);
  console.log(`\nHasil per pertanyaan ditulis ke ${jsonPath}.`);
}
