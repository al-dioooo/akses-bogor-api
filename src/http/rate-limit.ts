import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";

function ipHeader(request: FastifyRequest, name: string) {
  const value = request.headers[name];
  return typeof value === "string" && isIP(value) ? value : undefined;
}

/**
 * Kunci rate limit: IP klien dari header `cf-connecting-ip`, lalu `request.ip` untuk permintaan yang tidak lewat
 * Cloudflare (lokal, tes). Header itu ditulis Cloudflare dan diteruskan cloudflared apa adanya; API hanya mendengar di
 * 127.0.0.1, jadi klien tidak bisa mengisinya. `X-Forwarded-For` tidak dipakai karena entri kirinya diisi klien.
 */
export function rateLimitKey(request: FastifyRequest): string {
  return ipHeader(request, "cf-connecting-ip") ?? request.ip;
}
