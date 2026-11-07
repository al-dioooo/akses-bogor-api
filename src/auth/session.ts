import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { sessions } from "../db/schema.js";
import { HttpError } from "../http/errors.js";
import type { Auth } from "./auth.js";
import { PRIVACY_POLICY_VERSION, SESSION_MAX_DAYS } from "./rules.js";

const DAY_MS = 24 * 60 * 60 * 1000;

type AuthUser = {
  id: string;
  name: string;
  email: string;
  role?: string | null;
  privacyConsentAt?: Date | null;
  privacyPolicyVersion?: string | null;
  createdAt: Date;
};

export const userSchema = z
  .object({
    id: z.uuid(),
    displayName: z.string().describe("Kosong sampai Lengkapi Akun diisi"),
    email: z.email(),
    role: z.enum(["pengguna", "verifikator", "admin"]),
    needsCompletion: z
      .boolean()
      .describe("Benar bila nama tampilan atau persetujuan Kebijakan Privasi versi terbaru belum ada (FR-11); arahkan ke Lengkapi Akun"),
    createdAt: z.iso.datetime(),
  })
  .describe("Akun yang sedang masuk");

export type User = z.infer<typeof userSchema>;

/** Akun belum lengkap bila belum ada persetujuan, atau persetujuannya untuk versi Kebijakan Privasi yang lama. */
export const needsCompletion = (user: Pick<AuthUser, "privacyConsentAt" | "privacyPolicyVersion">) =>
  !user.privacyConsentAt || user.privacyPolicyVersion !== PRIVACY_POLICY_VERSION;

export function toUser(user: AuthUser): User {
  return {
    id: user.id,
    displayName: user.name,
    email: user.email,
    role: (user.role ?? "pengguna") as User["role"],
    needsCompletion: needsCompletion(user),
    createdAt: new Date(user.createdAt).toISOString(),
  };
}

/** Batas paling lama sesi (ADR-0029). Sesi bisa berakhir lebih cepat bila tidak dipakai 30 hari. */
export const sessionDeadline = (createdAt: Date) => new Date(new Date(createdAt).getTime() + SESSION_MAX_DAYS * DAY_MS);

/**
 * Sesi dari header `Authorization: Bearer` yang dikirim server web (ADR-0029), atau null. Sesi yang sudah lebih dari
 * 90 hari sejak masuk dihapus di sini, karena Better Auth hanya mengenal batas tidak dipakai.
 */
export async function currentSession(auth: Auth, db: Db, request: FastifyRequest, now: () => Date) {
  const authorization = request.headers.authorization;
  if (!authorization) return null;
  const result = await auth.api.getSession({ headers: new Headers({ authorization }) });
  if (!result) return null;
  if (sessionDeadline(result.session.createdAt) <= now()) {
    await db.delete(sessions).where(eq(sessions.id, result.session.id));
    return null;
  }
  return result;
}

export async function requireSession(auth: Auth, db: Db, request: FastifyRequest, now: () => Date) {
  const result = await currentSession(auth, db, request, now);
  if (!result) throw new HttpError(401, "belum_masuk", "Sesi Anda sudah berakhir. Silakan masuk lagi.");
  return result;
}
