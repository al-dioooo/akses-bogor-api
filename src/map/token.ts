// Token Mapbox sementara untuk browser (ADR-0016). Token rahasia hanya dipakai di sini untuk membuat token `tk.`
// lewat Mapbox Tokens API; browser tidak pernah menerimanya.

export type MapToken = { token: string; expiresAt: string };

/** Scope yang dibutuhkan Mapbox GL JS untuk gaya, tile, dan huruf. Token rahasia harus punya semuanya. */
export const MAP_TOKEN_SCOPES = ["styles:read", "styles:tiles", "fonts:read"];

// Mapbox membatasi token sementara paling lama satu jam; 55 menit memberi ruang untuk selisih jam.
const LIFETIME_MS = 55 * 60_000;
// Token yang sisa umurnya kurang dari ini tidak dibagikan lagi, supaya browser masih punya waktu memakainya.
const MIN_REMAINING_MS = 15 * 60_000;

type Options = { secretToken: string; username: string; now: () => Date; fetch?: typeof fetch };

/** Fungsi pemberi token yang memakai ulang token yang sama untuk semua pengunjung sampai sisa umurnya tinggal 15 menit. */
export function mapTokenSource({ secretToken, username, now, fetch = globalThis.fetch }: Options) {
  let current: MapToken | undefined;
  let pending: Promise<MapToken> | undefined;

  async function create(): Promise<MapToken> {
    const expiresAt = new Date(now().getTime() + LIFETIME_MS).toISOString();
    const url = `https://api.mapbox.com/tokens/v2/${encodeURIComponent(username)}?access_token=${encodeURIComponent(secretToken)}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expires: expiresAt, scopes: MAP_TOKEN_SCOPES }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Galat jaringan dibuat ulang tanpa URL, karena URL-nya memuat token rahasia.
      throw new Error("Mapbox Tokens API tidak bisa dihubungi");
    }
    const body = (await response.json().catch(() => null)) as { token?: unknown } | null;
    if (!response.ok || typeof body?.token !== "string") throw new Error(`Mapbox Tokens API menjawab ${response.status}`);
    return { token: body.token, expiresAt };
  }

  return async (): Promise<MapToken> => {
    if (current && Date.parse(current.expiresAt) - now().getTime() > MIN_REMAINING_MS) return current;
    // Request yang datang bersamaan menunggu pembuatan token yang sama.
    pending ??= create().finally(() => {
      pending = undefined;
    });
    current = await pending;
    return current;
  };
}
