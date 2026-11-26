// Mengambil atribut aksesibilitas Google Maps untuk kandidat OSM lewat aktor Apify (ADR-0056). Dataset mentah disimpan
// di luar repo, lalu dimuat dengan `pnpm petunjuk:google-impor`.
//
//   pnpm petunjuk:google-ambil --rencana       # jumlah pencarian dan perkiraan biaya, tanpa memanggil Apify
//   pnpm petunjuk:google-ambil --limit 20      # run kecil dulu
//   pnpm petunjuk:google-ambil                 # semua tempat
//
// Opsi lain: --hasil-per-tempat N (bawaan 1, paling banyak 5), --batas-usd X (bawaan perkiraan + 50%),
// --keluaran FOLDER (bawaan ~/data/akses-bogor/google-maps).
// Token dari env APIFY_TOKEN, atau dari ~/credentials/akses-bogor/apify.env (bisa diganti dengan APIFY_ENV_FILE).
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ApifyClient } from "apify-client";
import { loadEnv } from "../../src/config/env.js";
import { createDb } from "../../src/db/client.js";
import { APIFY_ACTOR, actorInput, apifyToken, chargeLimitUsd, DEFAULT_OUTPUT_DIR, estimateUsd, PRICE_PER_PLACE_USD, searchPlan, searchUrl } from "../../src/hints/apify.js";

const { values } = parseArgs({
  options: {
    limit: { type: "string" },
    rencana: { type: "boolean", default: false },
    "hasil-per-tempat": { type: "string", default: "1" },
    "batas-usd": { type: "string" },
    keluaran: { type: "string", default: DEFAULT_OUTPUT_DIR },
  },
});

function whole(value: string | undefined, name: string, max = Infinity) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${name} harus bilangan bulat ${max === Infinity ? "positif" : `1 sampai ${max}`}.`);
  return n;
}

const usd = (n: number, digits = 2) => `$${n.toFixed(digits)}`;

async function main() {
  const limit = whole(values.limit, "--limit");
  const perPlace = whole(values["hasil-per-tempat"], "--hasil-per-tempat", 5)!;

  const { db, pool } = createDb(loadEnv().DATABASE_URL);
  const plan = await searchPlan(db, limit).finally(() => pool.end());
  if (plan.places.length === 0) throw new Error("Tidak ada tempat OSM untuk dicari. Muat dulu dengan `pnpm pengetahuan:fasilitas`.");

  const counts = new Map<string, number>();
  for (const p of plan.places) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  const estimate = estimateUsd(plan.places.length, perPlace);
  const chargeLimit = values["batas-usd"] === undefined ? chargeLimitUsd(estimate) : Number(values["batas-usd"]);
  if (!(chargeLimit > 0)) throw new Error("--batas-usd harus angka lebih dari 0.");
  console.log(`${plan.places.length} pencarian (${[...counts].map(([c, n]) => `${c} ${n}`).join(", ")}), ${perPlace} hasil per pencarian.`);
  console.log(`Dilewati: ${plan.unnamed} tempat tanpa nama dan ${plan.generic} bernama umum, yang tidak bisa dicocokkan.`);
  console.log(`Perkiraan biaya paling banyak ${usd(estimate)} (${usd(PRICE_PER_PLACE_USD, 3)} per tempat, paket Free). Batas biaya run ${usd(chargeLimit)}.`);
  if (values.rencana) return;

  const token = await apifyToken();
  if (!token) throw new Error("APIFY_TOKEN tidak ditemukan. Isi env APIFY_TOKEN atau berkas ~/credentials/akses-bogor/apify.env (lokasi lain lewat APIFY_ENV_FILE).");
  const client = new ApifyClient({ token });
  const input = actorInput(plan.places, perPlace);
  const started = await client.actor(APIFY_ACTOR).start(input, { maxTotalChargeUsd: chargeLimit });
  console.log(`Run ${started.id} berjalan: https://console.apify.com/actors/runs/${started.id}`);
  const run = await client.run(started.id).waitForFinish();

  const items: unknown[] = [];
  for await (const item of client.dataset(run.defaultDatasetId).listItems({ clean: true })) items.push(item);

  const dir = resolve(values.keluaran);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(path, `${JSON.stringify(items, null, 2)}\n`);
  const meta = {
    aktor: APIFY_ACTOR,
    run: run.id,
    dataset: run.defaultDatasetId,
    status: run.status,
    mulai: run.startedAt,
    selesai: run.finishedAt,
    biayaUsd: run.usageTotalUsd ?? null,
    event: run.chargedEventCounts ?? null,
    hasilPerTempat: perPlace,
    jumlahHasil: items.length,
    tempat: plan.places.map((p) => ({ osm: `${p.osmType}/${p.osmId}`, kategori: p.category, nama: p.name, url: searchUrl(p) })),
  };
  await writeFile(`${path.slice(0, -".json".length)}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`Tersimpan: ${path} (${items.length} hasil Google, status ${run.status}, biaya ${run.usageTotalUsd === undefined ? "tidak diketahui" : usd(run.usageTotalUsd)}).`);
  if (run.status !== "SUCCEEDED") throw new Error(`Run berakhir dengan status ${run.status}; hasil yang sudah ada tetap tersimpan.`);
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
