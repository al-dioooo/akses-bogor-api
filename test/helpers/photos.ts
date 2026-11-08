// Foto buatan untuk tes, dibuat dengan sharp supaya tidak ada berkas biner di repo.
import { crc32 } from "node:zlib";
import sharp from "sharp";

const pixels = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: { r: 120, g: 80, b: 200 } } });

/** JPEG dengan EXIF berisi lokasi GPS, orientasi 6 (diputar 90°), dan nama kamera. */
export const jpegWithGps = (width = 400, height = 300) =>
  pixels(width, height)
    .jpeg()
    .withExif({
      IFD0: { Make: "KameraContoh" },
      IFD3: { GPSLatitudeRef: "S", GPSLatitude: "6/1 35/1 45/1", GPSLongitudeRef: "E", GPSLongitude: "106/1 47/1 39/1" },
    })
    .withMetadata({ orientation: 6 })
    .toBuffer();

export const png = (width = 300, height = 200) => pixels(width, height).png().toBuffer();
export const webp = (width = 300, height = 200) => pixels(width, height).webp().toBuffer();

/** PNG kecil yang header-nya mengaku berukuran `width` × `height`, untuk menguji batas piksel tanpa membuat foto besar. */
export async function pngClaiming(width: number, height: number) {
  const data = Buffer.from(await png(4, 4));
  // Chunk IHDR mulai di byte 8: panjang (4), "IHDR" (4), lebar (4), tinggi (4), lalu 5 byte lain dan CRC.
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  data.writeUInt32BE(crc32(data.subarray(12, 29)), 29);
  return data;
}
