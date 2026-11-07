// Pemeriksaan dan pemrosesan foto laporan di API (ADR-0023, ADR-0031). Browser sudah memperkecil foto, tetapi server
// tidak memercayai klien: jenis dibaca dari byte awal, ukuran dan jumlah piksel dibatasi, lalu foto disandikan ulang
// sebagai WebP. sharp tidak menyalin metadata apa pun, jadi EXIF (termasuk lokasi GPS), XMP, dan profil warna terbuang.
import sharp from "sharp";
import { HttpError } from "../http/errors.js";

// Satu foto sekaligus dan tanpa cache, supaya pemrosesan tidak menghabiskan memori Evergarden.
sharp.cache(false);
sharp.concurrency(1);

/** Batas berkas setelah diperkecil di browser. */
export const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
/** Batas piksel sebelum didekode, untuk menolak "bom dekompresi". */
export const MAX_INPUT_PIXELS = 40_000_000;
/** Sisi terpanjang foto yang disimpan. */
export const MAX_SIDE = 2048;

export type PhotoFormat = "jpeg" | "png" | "webp";
export type ProcessedPhoto = { data: Buffer; width: number; height: number; bytes: number; contentType: "image/webp" };

const ascii = (data: Uint8Array, from: number, to: number) => String.fromCharCode(...data.subarray(from, to));
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Jenis berkas dari byte awalnya, atau null bila bukan JPEG, PNG, atau WebP. Header Content-Type tidak dipakai. */
export function sniffPhoto(data: Uint8Array): PhotoFormat | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpeg";
  if (data.length >= 8 && PNG_SIGNATURE.every((byte, i) => data[i] === byte)) return "png";
  if (data.length >= 12 && ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 12) === "WEBP") return "webp";
  return null;
}

export const photoTooLarge = () =>
  new HttpError(413, "foto_terlalu_besar", "Foto ini terlalu besar. Batasnya 3 MB setelah diperkecil dan 40 megapiksel. Pilih foto lain.");

const unreadable = () => new HttpError(400, "foto_tidak_valid", "Berkas ini tidak bisa dibaca sebagai foto. Pilih foto JPEG, PNG, atau WebP lain.");

/** Memeriksa lalu menyandikan ulang foto: diputar sesuai orientasinya, sisi terpanjang ≤ 2048 px, WebP kualitas 80. */
export async function processPhoto(input: Buffer): Promise<ProcessedPhoto> {
  if (input.length > MAX_PHOTO_BYTES) throw photoTooLarge();
  const format = sniffPhoto(input);
  if (!format) throw new HttpError(415, "jenis_foto_tidak_didukung", "Foto harus berformat JPEG, PNG, atau WebP.");

  // metadata() hanya membaca header, jadi ukuran piksel diperiksa sebelum foto didekode.
  const meta = await sharp(input, { limitInputPixels: false })
    .metadata()
    .catch(() => {
      throw unreadable();
    });
  if (meta.format !== format || !meta.width || !meta.height) throw unreadable();
  if (meta.width * meta.height > MAX_INPUT_PIXELS) throw photoTooLarge();
  if ((meta.pages ?? 1) > 1) throw new HttpError(400, "foto_bergerak", "Foto bergerak (animasi) tidak diterima. Pilih foto biasa.");

  try {
    const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, autoOrient: true })
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, bytes: info.size, contentType: "image/webp" };
  } catch {
    throw unreadable();
  }
}
