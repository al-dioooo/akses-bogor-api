import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";

/** Header dari server Next.js: rahasia bersama dan IP pengunjung yang halamannya sedang dirender. */
export const WEB_SERVER_SECRET_HEADER = "x-web-server-secret";
export const VISITOR_IP_HEADER = "x-visitor-ip";

const digest = (value: string) => createHash("sha256").update(value).digest();

function ipHeader(request: FastifyRequest, name: string) {
  const value = request.headers[name];
  return typeof value === "string" && isIP(value) ? value : undefined;
}

/**
 * Kunci rate limit, diperiksa berurutan:
 * 1. Server web dengan `WEB_SERVER_SECRET` yang cocok: IP di `x-visitor-ip`. Halaman dirender di Vercel, jadi tanpa ini
 *    semua pengunjung berbagi kuota beberapa IP egress Vercel.
 * 2. `cf-connecting-ip`. Header ini ditulis Cloudflare dan diteruskan cloudflared apa adanya; API hanya mendengar di
 *    127.0.0.1, jadi klien tidak bisa mengisinya. `X-Forwarded-For` tidak dipakai karena entri kirinya diisi klien.
 * 3. `request.ip`, untuk permintaan yang tidak lewat Cloudflare (lokal, tes).
 */
export function createRateLimitKey(webServerSecret?: string) {
  const expected = webServerSecret ? digest(webServerSecret) : undefined;
  return (request: FastifyRequest): string => {
    const sent = request.headers[WEB_SERVER_SECRET_HEADER];
    if (expected && typeof sent === "string" && timingSafeEqual(digest(sent), expected)) {
      const visitor = ipHeader(request, VISITOR_IP_HEADER);
      if (visitor) return visitor;
    }
    return ipHeader(request, "cf-connecting-ip") ?? request.ip;
  };
}
