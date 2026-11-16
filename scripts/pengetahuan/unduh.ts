// Unduhan untuk skrip basis pengetahuan (ADR-0042). Setiap unduhan disimpan mentah di `.data/pengetahuan/` bersama
// alamat dan waktu ambilnya, supaya bisa dimuat ulang dengan `--salinan` tanpa mengunduh lagi dan tanpa mengubah
// tanggal ambil yang tercatat.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { loadEnv } from "../../src/config/env.js";
import { createDb, type Db } from "../../src/db/client.js";

/**
 * Header User-Agent. Bawaannya nama klien umum; syarat server Overpass FOSSGIS meminta nama aplikasi, jadi operator bisa
 * mengisi `PENGETAHUAN_USER_AGENT`, mis. dengan nama aplikasi dan alamat kontak tim.
 */
const USER_AGENT = process.env.PENGETAHUAN_USER_AGENT || "knowledge-loader/0.1 (node.js)";
export const RAW_DIR = ".data/pengetahuan";

export type Raw = { bytes: Buffer; url: string; retrievedAt: Date; sha256: string };

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Mengunduh satu alamat. Server yang sibuk (429, 502, 503, 504) dicoba sekali lagi setelah satu menit, tidak lebih,
 * sesuai kebijakan pemakaian Overpass.
 */
export async function download(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Raw> {
  const { timeoutMs = 60_000, ...rest } = init;
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, { ...rest, headers: { "user-agent": USER_AGENT, ...rest.headers }, signal: AbortSignal.timeout(timeoutMs) });
    if ([429, 502, 503, 504].includes(response.status) && attempt === 1) {
      console.warn(`${url} menjawab ${response.status}; dicoba lagi satu menit lagi.`);
      await wait(60_000);
      continue;
    }
    if (!response.ok) throw new Error(`${url} menjawab ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    return { bytes, url, retrievedAt: new Date(), sha256: sha256(bytes) };
  }
}

async function saveRaw(name: string, raw: Raw) {
  const path = join(RAW_DIR, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, raw.bytes);
  await writeFile(`${path}.meta.json`, `${JSON.stringify({ url: raw.url, retrievedAt: raw.retrievedAt.toISOString(), sha256: raw.sha256 }, null, 2)}\n`);
  return path;
}

async function readRaw(path: string): Promise<Raw> {
  const bytes = await readFile(path);
  const meta = JSON.parse(await readFile(`${path}.meta.json`, "utf8")) as { url: string; retrievedAt: string };
  return { bytes, url: meta.url, retrievedAt: new Date(meta.retrievedAt), sha256: sha256(bytes) };
}

/** Opsi `--salinan`: pakai salinan mentah terakhir di `.data/pengetahuan/`, tanpa mengunduh. */
const fromCopy = parseArgs({ options: { salinan: { type: "boolean", default: false } } }).values.salinan;

/** Isi `url`, dari salinan mentah bila `--salinan` dipakai, atau diunduh lalu disimpan sebagai `name`. */
export async function obtain(name: string, url: string, init?: Parameters<typeof download>[1]): Promise<Raw> {
  if (fromCopy) return readRaw(join(RAW_DIR, name));
  const raw = await download(url, init);
  console.log(`Salinan mentah: ${await saveRaw(name, raw)}`);
  return raw;
}

/** Menjalankan `work` dengan database dari `DATABASE_URL`, lalu menutup koneksinya. */
export async function withDb(work: (db: Db) => Promise<void>) {
  const { db, pool } = createDb(loadEnv().DATABASE_URL);
  try {
    await work(db);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
