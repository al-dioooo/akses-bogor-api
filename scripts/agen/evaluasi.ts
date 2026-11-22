// Menjalankan pertanyaan uji agen untuk kontributor (ADR-0043, ADR-0047) sekali ke penyedia model sungguhan, lalu
// mencetak jawaban, model, sumber, kartu, hasil pemeriksaan otomatis, jumlah permintaan, dan, untuk Claude, token serta
// perkiraan biayanya. Penyedianya mengikuti `AGENT_PROVIDER` (bawaan Claude API, effort dari `ANTHROPIC_EFFORT`). Data
// disabilitas dipakai di sini (database dev) supaya alat prioritas kecamatan ikut diuji; di production flag-nya tetap
// mati. Setiap kali jalan memakai kuota atau saldo penyedia, jadi jalankan seperlunya. Pemeriksaan otomatis hanya
// bantuan; keputusan lulus atau gagal tetap dibaca manusia dari jawabannya.
//
//   pnpm agen:evaluasi            semua pertanyaan
//   pnpm agen:evaluasi K01 K06    hanya pertanyaan tertentu
import { readFileSync } from "node:fs";
import { DEFAULT_EFFORT } from "../../src/agent/anthropic.js";
import { askAgent, type Turn } from "../../src/agent/ask.js";
import { agentModel } from "../../src/agent/provider.js";
import { loadEnv } from "../../src/config/env.js";
import { createDb } from "../../src/db/client.js";
import { placesNamed } from "../../src/places/queries.js";

type Question = { id: string; jenis: string; tempat?: string; pertanyaan: string; riwayat?: Turn[]; kriteria: string; harus: string[]; tidak_boleh: string[]; kartu?: string };
type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

const env = loadEnv();
if (env.NODE_ENV === "production") {
  console.error("Evaluasi tidak dijalankan di production.");
  process.exit(1);
}
const claude = env.AGENT_PROVIDER === "anthropic";
const keyName = claude ? "ANTHROPIC_API_KEY" : "OPENROUTER_API_KEY";
if (!env[keyName]) {
  console.error(`${keyName} belum diisi.`);
  process.exit(1);
}

/** Pengaman supaya satu kali jalan tidak menghabiskan kuota harian: permintaan HTTP, dan yang berhasil. */
const MAX_REQUESTS = 40;
const MAX_SUCCEEDED = Number(process.env.EVALUASI_MAKS_BERHASIL ?? (claude ? 40 : 14));
/** Jeda antarpertanyaan untuk OpenRouter: di bawah batas 20 permintaan per menit, dan memberi waktu bila model gratis dibatasi. */
const PAUSE_MS = claude ? 0 : 15_000;
/**
 * Harga Claude Haiku 5.5 per juta token untuk prompt sampai 100 ribu token: input, output, baca cache (0,1x input), dan
 * tulis cache 5 menit (1,25x input). Hanya untuk perkiraan; cek halaman harga Anthropic sebelum dipakai sebagai anggaran.
 */
const USD_PER_MTOK = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 };
const cost = (t: Tokens) => (t.input * USD_PER_MTOK.input + t.output * USD_PER_MTOK.output + t.cacheRead * USD_PER_MTOK.cacheRead + t.cacheWrite * USD_PER_MTOK.cacheWrite) / 1_000_000;
const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const add = (a: Tokens, b: Tokens) => {
  for (const key of Object.keys(a) as (keyof Tokens)[]) a[key] += b[key];
};
const show = (t: Tokens) => `input ${t.input}, output ${t.output}, baca cache ${t.cacheRead}, tulis cache ${t.cacheWrite}, ~US$${cost(t).toFixed(5)}`;

const all = JSON.parse(readFileSync(new URL("./pertanyaan-uji.json", import.meta.url), "utf8")) as Question[];
const wanted = process.argv.slice(2);
const questions = wanted.length > 0 ? all.filter((q) => wanted.includes(q.id)) : all;

let requests = 0;
let succeeded = 0;
const countingFetch: typeof fetch = async (input, init) => {
  requests += 1;
  const response = await fetch(input, init);
  if (response.ok) succeeded += 1;
  return response;
};
/** Token per langkah Claude, dari log adapter; urutan baca cache per langkah menunjukkan apakah cache dipakai. */
let steps: Tokens[] = [];
const model = agentModel(env, {
  fetch: countingFetch,
  budget: { take: () => requests < MAX_REQUESTS && succeeded < MAX_SUCCEEDED, give: () => {} },
  log: {
    info: (details) => steps.push({ input: Number(details.input), output: Number(details.output), cacheRead: Number(details.cacheRead), cacheWrite: Number(details.cacheWrite) }),
    warn: (details, message) => console.log(`  [peringatan] ${message} ${JSON.stringify(details)}`),
  },
})!;
console.log(claude ? `Penyedia: Claude API, model ${env.ANTHROPIC_MODEL ?? "claude-haiku-5-5"}, effort ${env.ANTHROPIC_EFFORT ?? DEFAULT_EFFORT}` : "Penyedia: OpenRouter");

const { db, pool } = createDb(env.DATABASE_URL);
const ctx = { db, now: () => new Date(), disabilityData: true };
const summary: string[] = [];
const total = zero();

for (const [index, q] of questions.entries()) {
  if (index > 0) await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
  const place = q.tempat ? (await placesNamed(db, q.tempat, 5)).find((p) => p.name === q.tempat) : undefined;
  if (q.tempat && !place) throw new Error(`Tempat "${q.tempat}" tidak ada di database. Jalankan pnpm db:seed dulu.`);
  const before = requests;
  if (succeeded >= MAX_SUCCEEDED) {
    console.log(`\n=== ${q.id}: tidak dijalankan, batas ${MAX_SUCCEEDED} permintaan berhasil tercapai`);
    summary.push(`${q.id}\ttidak dijalankan\t0\t-`);
    continue;
  }
  console.log(`\n=== ${q.id} (${q.jenis})${q.tempat ? ` · dari halaman ${q.tempat}` : ""}\nTanya: ${q.pertanyaan}\nKriteria: ${q.kriteria}`);
  steps = [];
  try {
    const result = await askAgent({ model, ctx }, { placeId: place?.id, question: q.pertanyaan, history: q.riwayat });
    const missing = q.harus.filter((pattern) => !new RegExp(pattern, "i").test(result.answer));
    const forbidden = q.tidak_boleh.filter((pattern) => new RegExp(pattern, "im").test(result.answer));
    const cardMissing = q.kartu !== undefined && !result.cards.some((c) => c.type === q.kartu);
    const check = missing.length === 0 && forbidden.length === 0 && !cardMissing ? "lolos" : "perlu dicek";
    console.log(`Model: ${result.model ?? "-"} · permintaan: ${requests - before}`);
    console.log(`Jawab:\n${result.answer}`);
    console.log(`Sumber: ${result.sources.map((s) => (s.type === "lokasi" ? `lokasi ${s.name}` : s.citation)).join("; ")}`);
    console.log(`Kartu: ${result.cards.map((c) => (c.type === "prioritas" ? "prioritas" : `${c.type} ${c.name ?? JSON.stringify(c.target)}`)).join("; ") || "-"}${cardMissing ? ` · kartu ${q.kartu} tidak muncul` : ""}`);
    console.log(`Pemeriksaan otomatis: ${check}${missing.length ? ` · tidak ditemukan: ${missing.join(", ")}` : ""}${forbidden.length ? ` · terlarang: ${forbidden.join(", ")}` : ""}`);
    summary.push(`${q.id}\t${check}\t${requests - before}\t${result.model ?? "-"}`);
  } catch (error) {
    console.log(`Galat: ${error instanceof Error ? error.message : String(error)} · permintaan: ${requests - before}`);
    summary.push(`${q.id}\tgalat\t${requests - before}\t-`);
  }
  if (claude) {
    const tokens = zero();
    for (const t of steps) add(tokens, t);
    add(total, tokens);
    console.log(`Token: ${show(tokens)} · baca cache per langkah: ${steps.map((t) => t.cacheRead).join(" → ") || "-"}`);
    summary[summary.length - 1] += `\t${cost(tokens).toFixed(5)}`;
  }
}

await pool.end();
console.log(
  `\n=== Ringkasan (id, pemeriksaan otomatis, permintaan, model${claude ? ", perkiraan US$" : ""})\n${summary.join("\n")}\nTotal permintaan HTTP: ${requests}, yang berhasil: ${succeeded}`,
);
if (claude) {
  const asked = summary.filter((line) => !line.includes("tidak dijalankan")).length;
  console.log(`Total token: ${show(total)}${asked ? ` · rata-rata ~US$${(cost(total) / asked).toFixed(5)} per pertanyaan` : ""}`);
}
