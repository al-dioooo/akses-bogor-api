// Menjalankan pertanyaan uji agen untuk kontributor (ADR-0043) sekali ke model OpenRouter sungguhan, lalu mencetak
// jawaban, model, sumber, kartu, hasil pemeriksaan otomatis, dan jumlah permintaan. Data disabilitas dipakai di sini
// (database dev) supaya alat prioritas kecamatan ikut diuji; di production flag-nya tetap mati. Memakai kuota gratis (sekitar 50 permintaan per hari untuk
// seluruh akun OpenRouter), jadi jalankan seperlunya. Pemeriksaan otomatis hanya bantuan; keputusan lulus atau gagal
// tetap dibaca manusia dari jawabannya.
//
//   pnpm agen:evaluasi            semua pertanyaan
//   pnpm agen:evaluasi K01 K06    hanya pertanyaan tertentu
import { readFileSync } from "node:fs";
import { askAgent, type Turn } from "../../src/agent/ask.js";
import { DEFAULT_MODELS, openRouterModel } from "../../src/agent/openrouter.js";
import { loadEnv } from "../../src/config/env.js";
import { createDb } from "../../src/db/client.js";
import { placesNamed } from "../../src/places/queries.js";

/** Pengaman supaya satu kali jalan tidak menghabiskan kuota harian: permintaan HTTP, dan yang berhasil (dihitung OpenRouter). */
const MAX_REQUESTS = 40;
const MAX_SUCCEEDED = Number(process.env.EVALUASI_MAKS_BERHASIL ?? 14);
/** Jeda antarpertanyaan: di bawah batas 20 permintaan per menit, dan memberi waktu bila model gratis sedang dibatasi. */
const PAUSE_MS = 15_000;

type Question = { id: string; jenis: string; tempat?: string; pertanyaan: string; riwayat?: Turn[]; kriteria: string; harus: string[]; tidak_boleh: string[]; kartu?: string };

const env = loadEnv();
if (env.NODE_ENV === "production") {
  console.error("Evaluasi tidak dijalankan di production.");
  process.exit(1);
}
if (!env.OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY belum diisi.");
  process.exit(1);
}

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
const model = openRouterModel({
  apiKey: env.OPENROUTER_API_KEY,
  models: env.OPENROUTER_MODELS.length > 0 ? env.OPENROUTER_MODELS : DEFAULT_MODELS,
  fetch: countingFetch,
  budget: { take: () => requests < MAX_REQUESTS && succeeded < MAX_SUCCEEDED, give: () => {} },
  log: { warn: (details, message) => console.log(`  [peringatan] ${message} ${JSON.stringify(details)}`) },
});

const { db, pool } = createDb(env.DATABASE_URL);
const ctx = { db, now: () => new Date(), disabilityData: true };
const summary: string[] = [];

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
}

await pool.end();
console.log(
  `\n=== Ringkasan (id, pemeriksaan otomatis, permintaan, model)\n${summary.join("\n")}\nTotal permintaan HTTP ke OpenRouter: ${requests}, yang berhasil (dihitung kuota OpenRouter): ${succeeded}`,
);
