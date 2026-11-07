// ID token Google tiruan: kunci RSA dibuat saat tes, dan sertifikat Google dijawab dengan kunci publiknya.
import { createSign, generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "kunci-tes";
const CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** Menandatangani ID token seperti yang dibuat Google Identity Services. `claims` menimpa nilai bawaan. */
export function googleIdToken(claims: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: "https://accounts.google.com", aud: "client-tes", sub: "1000", iat: now, exp: now + 600, email_verified: true, ...claims };
  const unsigned = `${base64url({ alg: "RS256", kid: KID, typ: "JWT" })}.${base64url(payload)}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

/** `fetch` yang menjawab sertifikat Google dengan kunci tes dan meneruskan alamat lain ke `fallback`. */
export function googleCertsFetch(fallback: typeof fetch = fetch): typeof fetch {
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(CERTS_URL)) return Response.json({ keys: [jwk] });
    return fallback(input, init);
  };
}
