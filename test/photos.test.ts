import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_PHOTO_BYTES, processPhoto, sniffPhoto } from "../src/photos/process.js";
import { localStore, r2Store, reportPhotoKey } from "../src/photos/storage.js";
import { jpegWithGps, png, pngClaiming, webp } from "./helpers/photos.js";

const galat = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return { status: (error as { statusCode?: number }).statusCode, code: (error as { code?: string }).code };
  }
  throw new Error("expected a rejection");
};

describe("sniffPhoto", () => {
  it("reads the type from the first bytes, not the name or header", async () => {
    expect(sniffPhoto(await jpegWithGps())).toBe("jpeg");
    expect(sniffPhoto(await png())).toBe("png");
    expect(sniffPhoto(await webp())).toBe("webp");
    expect(sniffPhoto(Buffer.from("GIF89a"))).toBeNull();
    expect(sniffPhoto(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffPhoto(Buffer.alloc(0))).toBeNull();
  });
});

describe("processPhoto", () => {
  it("drops EXIF with the GPS location and applies the orientation", async () => {
    const input = await jpegWithGps(400, 300);
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const photo = await processPhoto(input);
    const meta = await sharp(photo.data).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    // Orientasi 6 berarti foto berdiri: 400×300 menjadi 300×400.
    expect([photo.width, photo.height]).toEqual([300, 400]);
    expect(photo.data.includes(Buffer.from("KameraContoh"))).toBe(false);
    expect(photo.bytes).toBe(photo.data.length);
    expect(photo.contentType).toBe("image/webp");
  });

  it("shrinks the longest side to 2048 px and never enlarges", async () => {
    expect(await processPhoto(await png(3000, 1500))).toMatchObject({ width: 2048, height: 1024 });
    expect(await processPhoto(await webp(640, 480))).toMatchObject({ width: 640, height: 480 });
  });

  it("rejects files that are not JPEG, PNG, or WebP", async () => {
    const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).gif().toBuffer();
    expect(await galat(processPhoto(gif))).toEqual({ status: 415, code: "jenis_foto_tidak_didukung" });
    expect(await galat(processPhoto(Buffer.from("bukan foto sama sekali")))).toEqual({ status: 415, code: "jenis_foto_tidak_didukung" });
  });

  it("rejects broken and disguised files", async () => {
    const jpeg = await jpegWithGps();
    expect(await galat(processPhoto(jpeg.subarray(0, 200)))).toEqual({ status: 400, code: "foto_tidak_valid" });
    // Byte awal JPEG, isinya PNG.
    const disguised = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), await png()]);
    expect(await galat(processPhoto(disguised))).toEqual({ status: 400, code: "foto_tidak_valid" });
  });

  it("rejects files over 3 MB and images over 40 megapixels", async () => {
    expect(await galat(processPhoto(Buffer.alloc(MAX_PHOTO_BYTES + 1, 0xff)))).toEqual({ status: 413, code: "foto_terlalu_besar" });
    const huge = await pngClaiming(8000, 6000);
    expect((await sharp(huge).metadata()).width).toBe(8000);
    expect(await galat(processPhoto(huge))).toEqual({ status: 413, code: "foto_terlalu_besar" });
  });

  it("rejects animated images", async () => {
    const frame = (background: string) => sharp({ create: { width: 20, height: 20, channels: 4, background } }).raw().toBuffer();
    const twoFrames = await sharp(Buffer.concat([await frame("#000"), await frame("#fff")]), { raw: { width: 20, height: 40, channels: 4, pageHeight: 20 } })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();
    expect((await sharp(twoFrames).metadata()).pages).toBe(2);
    expect(await galat(processPhoto(twoFrames))).toEqual({ status: 400, code: "foto_bergerak" });
  });
});

describe("localStore", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "foto-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps report photos and published photos in separate folders", async () => {
    const store = localStore(dir);
    const key = reportPhotoKey("0b6c1b2e-3f4a-4b5c-8d9e-0f1a2b3c4d5e");
    await store.put(key, Buffer.from("isi"), "image/webp");
    expect(await readFile(path.join(dir, "privat", key), "utf8")).toBe("isi");
    await store.put("lokasi/tempat/foto.webp", Buffer.from("publik"), "image/webp");
    expect(await readFile(path.join(dir, "publik", "lokasi/tempat/foto.webp"), "utf8")).toBe("publik");
    expect(Buffer.from(await store.get(key)).toString()).toBe("isi");
    await store.remove(key);
    await store.remove(key);
    await expect(stat(path.join(dir, "privat", key))).rejects.toThrow();
  });

  it("refuses keys that could leave the folder", async () => {
    const store = localStore(dir);
    for (const key of ["../luar.webp", "laporan/../../luar.webp", "/etc/passwd", "lain/foto.webp"]) {
      await expect(store.put(key, Buffer.from("x"), "image/webp")).rejects.toThrow(/Kunci foto tidak valid/);
    }
  });
});

describe("r2Store", () => {
  const options = {
    accountId: "0123456789abcdef0123456789abcdef",
    accessKeyId: "kunci",
    secretAccessKey: "rahasia",
    privateBucket: "foto-laporan",
    publicBucket: "foto-publik",
  };

  it("signs PUT and DELETE requests to the right bucket", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 200 }));
    const store = r2Store({ ...options, fetch });
    await store.put("laporan/abc.webp", Buffer.from("isi"), "image/webp");
    await store.remove("lokasi/tempat/abc.webp");
    const [put, del] = fetch.mock.calls.map(([request]) => request as Request);
    expect(put!.method).toBe("PUT");
    expect(put!.url).toBe("https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/foto-laporan/laporan/abc.webp");
    expect(put!.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=kunci\/\d{8}\/auto\/s3\/aws4_request/);
    expect(put!.headers.get("content-type")).toBe("image/webp");
    expect(del!.method).toBe("DELETE");
    expect(del!.url).toContain("/foto-publik/lokasi/tempat/abc.webp");
  });

  it("reads a file back with a signed GET", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("isi", { status: 200 }));
    const data = await r2Store({ ...options, fetch }).get("laporan/abc.webp");
    expect(Buffer.from(data).toString()).toBe("isi");
    const [request] = fetch.mock.calls[0]!;
    expect((request as Request).method).toBe("GET");
    expect((request as Request).url).toContain("/foto-laporan/laporan/abc.webp");
    await expect(r2Store({ ...options, fetch: async () => new Response(null, { status: 404 }) }).get("laporan/abc.webp")).rejects.toThrow("R2 menjawab 404 untuk GET");
  });

  it("treats a missing file as deleted and other answers as errors", async () => {
    const answer = (status: number) => r2Store({ ...options, fetch: async () => new Response(null, { status }) });
    await expect(answer(404).remove("laporan/abc.webp")).resolves.toBeUndefined();
    await expect(answer(403).put("laporan/abc.webp", Buffer.from("x"), "image/webp")).rejects.toThrow("R2 menjawab 403 untuk PUT laporan/abc.webp");
    await expect(r2Store({ ...options, fetch: async () => Promise.reject(new Error("rahasia")) }).remove("laporan/abc.webp")).rejects.toThrow(
      "R2 tidak bisa dihubungi",
    );
  });
});
