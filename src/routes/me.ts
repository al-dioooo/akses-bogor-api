import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { Auth } from "../auth/auth.js";
import { requireSession, toUser, userSchema } from "../auth/session.js";
import { HttpError, errorSchema } from "../http/errors.js";

export type MeRouteOptions = { auth?: Auth; now: () => Date };

const TAG = "Akun";

/** Route untuk akun yang sedang masuk. Server web mengirim token sesi sebagai `Authorization: Bearer` (ADR-0029). */
export const meRoutes: FastifyPluginAsyncZod<MeRouteOptions> = async (app, opts) => {
  const session = async (request: Parameters<typeof requireSession>[2]) => {
    if (!opts.auth) throw new HttpError(503, "akun_belum_diatur", "Fitur akun belum diatur di server.");
    return requireSession(opts.auth, app.db, request, opts.now);
  };

  app.get(
    "/me",
    {
      schema: {
        tags: [TAG],
        summary: "Akun yang sedang masuk",
        description: "Nama tampilan, email, dan peran (FR-12). `needsCompletion` benar berarti web mengarahkan ke Lengkapi Akun.",
        response: { 200: userSchema, 401: errorSchema, 503: errorSchema },
      },
    },
    async (request, reply) => {
      const { user } = await session(request);
      reply.header("cache-control", "no-store");
      return toUser(user);
    },
  );
};
