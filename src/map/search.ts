// Pencarian tempat untuk pemilih lokasi di formulir laporan (ADR-0032): Mapbox Search Box `/forward` dipanggil dari
// server dengan token rahasia, jadi browser tidak pernah menerima token dan Mapbox tidak menerima IP pelapor. Hasilnya
// hanya menggeser peta dan tidak disimpan (ADR-0016).

export type SearchPoint = { lat: number; lng: number };
export type SearchResult = { name: string; address: string | null; location: SearchPoint; kind: string };

/** Kotak di sekitar Kota Bogor: barat, selatan, timur, utara. Sedikit lebih luas dari batas kota (ADR-0034). */
export const KOTA_BOGOR_BBOX = [106.72, -6.69, 106.86, -6.5] as const;
/** Tengah Kota Bogor, dipakai bila pelapor belum menggeser peta. */
const CENTER: SearchPoint = { lat: -6.5971, lng: 106.7972 };
/** Jenis hasil yang berguna untuk menemukan pintu masuk: tempat, alamat, jalan, dan kelurahan. */
const TYPES = "poi,address,street,neighborhood,locality";
/** Batas harian bawaan untuk seluruh pengguna, supaya pemakaian tetap di kuota gratis (ADR-0032). */
export const SEARCHES_PER_DAY = 1500;

/** Batas harian tercapai; dihitung ulang tengah malam WIB. */
export class SearchQuotaError extends Error {}

type Options = { token: string; now: () => Date; fetch?: typeof fetch; perDay?: number };

type Feature = {
  geometry?: { coordinates?: [number, number] };
  properties?: { name?: string; full_address?: string; place_formatted?: string; feature_type?: string };
};

/** Tanggal di WIB (UTC+7), untuk menghitung ulang batas harian tengah malam WIB. */
const wibDate = (date: Date) => new Date(date.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);

export function mapboxSearch({ token, now, fetch = globalThis.fetch, perDay = SEARCHES_PER_DAY }: Options) {
  let day = "";
  let used = 0;

  return async (query: string, near: SearchPoint = CENTER): Promise<SearchResult[]> => {
    const today = wibDate(now());
    if (today !== day) {
      day = today;
      used = 0;
    }
    if (used >= perDay) throw new SearchQuotaError("Batas pencarian harian tercapai");
    used += 1;

    const url = new URL("https://api.mapbox.com/search/searchbox/v1/forward");
    url.search = new URLSearchParams({
      q: query,
      access_token: token,
      auto_complete: "true",
      bbox: KOTA_BOGOR_BBOX.join(","),
      proximity: `${near.lng},${near.lat}`,
      country: "id",
      language: "id",
      limit: "5",
      types: TYPES,
    }).toString();
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    } catch {
      // Galat jaringan dibuat ulang tanpa URL, karena URL-nya memuat token rahasia.
      throw new Error("Mapbox Search Box tidak bisa dihubungi");
    }
    const body = (await response.json().catch(() => null)) as { features?: Feature[] } | null;
    if (!response.ok || !Array.isArray(body?.features)) throw new Error(`Mapbox Search Box menjawab ${response.status}`);
    return body.features.flatMap((feature) => {
      const [lng, lat] = feature.geometry?.coordinates ?? [];
      const name = feature.properties?.name;
      if (typeof lng !== "number" || typeof lat !== "number" || !name) return [];
      const address = feature.properties?.full_address ?? feature.properties?.place_formatted ?? null;
      return [{ name, address: address === name ? null : address, location: { lat, lng }, kind: feature.properties?.feature_type ?? "poi" }];
    });
  };
}
