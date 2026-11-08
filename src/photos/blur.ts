// Mengaburkan area foto sebelum terbit (FR-34, ADR-0037). Setiap area diperkecil sampai sisi terpanjangnya paling
// banyak 8 piksel, diperbesar lagi, lalu dihaluskan, sehingga detail wajah dan huruf pelat hilang. Foto laporan sudah
// diputar sesuai orientasinya saat diunggah, jadi koordinat area sama dengan yang dilihat verifikator.
import sharp, { type OverlayOptions } from "sharp";
import type { BlurRegion } from "../db/schema.js";
import type { ProcessedPhoto } from "./process.js";

/** Sisi terpanjang area setelah diperkecil. */
export const BLUR_BLOCK = 8;
/** Paling banyak area per foto. */
export const MAX_BLUR_REGIONS = 20;

/** Area dalam piksel, dibulatkan keluar dan dipotong ke dalam batas foto. */
export function toPixels(region: BlurRegion, width: number, height: number) {
  const left = Math.min(width - 1, Math.max(0, Math.floor(region.x * width)));
  const top = Math.min(height - 1, Math.max(0, Math.floor(region.y * height)));
  const right = Math.min(width, Math.max(left + 1, Math.ceil((region.x + region.w) * width)));
  const bottom = Math.min(height, Math.max(top + 1, Math.ceil((region.y + region.h) * height)));
  return { left, top, width: right - left, height: bottom - top };
}

/** Foto WebP baru dengan area yang dikaburkan, tanpa metadata. Tanpa area, foto hanya disandikan ulang. */
export async function blurPhoto(input: Uint8Array, regions: readonly BlurRegion[]): Promise<ProcessedPhoto> {
  const meta = await sharp(input).metadata();
  const width = meta.width!;
  const height = meta.height!;
  const composites: OverlayOptions[] = [];
  for (const region of regions) {
    const area = toPixels(region, width, height);
    const scale = BLUR_BLOCK / Math.max(area.width, area.height);
    const small = await sharp(input)
      .extract(area)
      .resize(Math.max(1, Math.round(area.width * Math.min(1, scale))), Math.max(1, Math.round(area.height * Math.min(1, scale))), { fit: "fill" })
      .png()
      .toBuffer();
    const sigma = Math.max(1, Math.max(area.width, area.height) / 32);
    const enlarged = await sharp(small).resize(area.width, area.height, { fit: "fill", kernel: "cubic" }).blur(sigma).png().toBuffer();
    composites.push({ input: enlarged, left: area.left, top: area.top });
  }
  const { data, info } = await sharp(input).composite(composites).webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, bytes: info.size, contentType: "image/webp" };
}
