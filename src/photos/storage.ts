// Penyimpanan berkas foto (ADR-0031): Cloudflare R2 di production, folder lokal di development. Foto laporan ada di
// bucket privat dengan kunci `laporan/…`; foto yang sudah terbit ada di bucket publik dengan kunci `lokasi/…`.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AwsClient } from "aws4fetch";

export type PhotoStore = {
  /** Menyimpan berkas; galat bila gagal. */
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  /** Membaca berkas; galat bila tidak ada atau gagal (ADR-0037). */
  get(key: string): Promise<Uint8Array>;
  /** Menghapus berkas; berkas yang sudah tidak ada dianggap berhasil. */
  remove(key: string): Promise<void>;
};

/** Kunci berkas foto laporan di bucket privat. */
export const reportPhotoKey = (photoId: string) => `laporan/${photoId}.webp`;

// Kunci selalu dibuat API dari UUID; pola ini menolak kunci lain, termasuk `..`.
const KEY = /^(laporan|lokasi)\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.[a-z]+$/;

function checkKey(key: string) {
  if (!KEY.test(key)) throw new Error(`Kunci foto tidak valid: ${key}`);
  return key;
}

/** `lokasi/…` ada di bucket publik, selebihnya di bucket privat. */
const isPublic = (key: string) => key.startsWith("lokasi/");

export type R2Options = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  privateBucket: string;
  publicBucket: string;
  fetch?: typeof fetch;
};

/** R2 lewat S3 API, ditandatangani aws4fetch (AWS Signature V4). */
export function r2Store({ accountId, accessKeyId, secretAccessKey, privateBucket, publicBucket, fetch = globalThis.fetch }: R2Options): PhotoStore {
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });
  const url = (key: string) => `https://${accountId}.r2.cloudflarestorage.com/${isPublic(key) ? publicBucket : privateBucket}/${checkKey(key)}`;

  async function send(key: string, init: RequestInit, ok: (status: number) => boolean) {
    const request = await client.sign(url(key), init);
    let response: Response;
    try {
      response = await fetch(request, { signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new Error("R2 tidak bisa dihubungi");
    }
    if (!ok(response.status)) throw new Error(`R2 menjawab ${response.status} untuk ${init.method} ${key}`);
    return response;
  }

  return {
    put: async (key, data, contentType) => {
      await send(key, { method: "PUT", body: data as Uint8Array<ArrayBuffer>, headers: { "content-type": contentType } }, (status) => status >= 200 && status < 300);
    },
    get: async (key) => new Uint8Array(await (await send(key, { method: "GET" }, (status) => status === 200)).arrayBuffer()),
    remove: async (key) => {
      await send(key, { method: "DELETE" }, (status) => (status >= 200 && status < 300) || status === 404);
    },
  };
}

/** Folder lokal untuk development: `<dir>/privat/…` dan `<dir>/publik/…`. */
export function localStore(dir: string): PhotoStore {
  const file = (key: string) => path.join(dir, isPublic(key) ? "publik" : "privat", checkKey(key));
  return {
    async put(key, data) {
      const target = file(key);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data);
    },
    async get(key) {
      return new Uint8Array(await readFile(file(key)));
    },
    async remove(key) {
      await rm(file(key), { force: true });
    },
  };
}
