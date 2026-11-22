// Encoded polyline presisi 6 (format yang sama dengan `geometries=polyline6` Mapbox), supaya garis rute bisa
// dikirim browser ke route hambatan sebagai satu string pendek, bukan larik koordinat.

const FACTOR = 1e6;

function encodeValue(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = "";
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>>= 5;
  }
  return out + String.fromCharCode(v + 63);
}

/** Koordinat [lng, lat] menjadi polyline6. */
export function encodePolyline(coordinates: readonly [number, number][]): string {
  let lat = 0;
  let lng = 0;
  let out = "";
  for (const [x, y] of coordinates) {
    const nextLat = Math.round(y * FACTOR);
    const nextLng = Math.round(x * FACTOR);
    out += encodeValue(nextLat - lat) + encodeValue(nextLng - lng);
    lat = nextLat;
    lng = nextLng;
  }
  return out;
}

/** Polyline6 menjadi koordinat [lng, lat]. Melempar galat bila string-nya rusak. */
export function decodePolyline(encoded: string): [number, number][] {
  const coordinates: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (index >= encoded.length) throw new Error("polyline terpotong");
      byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 63) throw new Error("karakter polyline tidak valid");
      result |= (byte & 0x1f) << shift;
      shift += 5;
      if (shift > 30) throw new Error("nilai polyline terlalu besar");
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += next();
    lng += next();
    coordinates.push([lng / FACTOR, lat / FACTOR]);
  }
  return coordinates;
}
