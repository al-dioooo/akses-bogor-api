import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AGENT_TOOLS, toolDefinitions } from "../agent/registry.js";
import type { ToolContext } from "../agent/tools.js";
import type { Auth } from "../auth/auth.js";
import { needsCompletion, requireSession } from "../auth/session.js";
import { HttpError, errorSchema } from "../http/errors.js";
import type { WalkingRouter } from "../map/directions.js";

const TAG = "Agen rute";
const HOUR_MS = 60 * 60 * 1000;
/** Panggilan semua alat per akun per jam: cukup untuk belasan pertanyaan yang masing-masing memanggil beberapa alat. */
export const TOOL_CALLS_PER_HOUR = 120;
/** Rute jalan kaki per akun per jam; setiap rute memakai satu permintaan Mapbox Directions. */
export const WALKING_ROUTES_PER_HOUR = 30;

export type AgentRouteOptions = {
  /** Kosong bila `BETTER_AUTH_SECRET` belum diatur di production. */
  auth?: Auth;
  /** `ROUTE_AGENT_ENABLED`. Mati sampai syarat peluncuran di ADR-0042 terpenuhi. */
  enabled: boolean;
  /** Kosong bila `MAPBOX_SECRET_TOKEN` belum diatur. */
  walking?: WalkingRouter;
  now: () => Date;
};

const definitions = z.object({
  tools: z.array(
    z.object({ name: z.string(), description: z.string(), inputSchema: z.record(z.string(), z.unknown()).describe("JSON Schema input alat") }),
  ),
});

const COMMON =
  "Hanya untuk akun yang sudah masuk dan melengkapi akun (ADR-0042). Menjawab 503 `agen_rute_belum_aktif` selama `ROUTE_AGENT_ENABLED` mati. Semua alat berbagi batas 120 panggilan per akun per jam. Data dikirim di badan permintaan supaya tidak tercatat di log.";
const EXTRA: Record<string, string> = {
  walking_route: " Posisi dibulatkan ke 4 desimal sebelum dikirim ke Mapbox Directions, dan jawaban Mapbox tidak disimpan. Batas tambahan 30 rute per akun per jam dan 1.000 rute per hari untuk semua pengguna.",
};

/** Alat agen rute sebagai route API (ADR-0042). Belum ada model bahasa: route ini dipanggil langsung atau oleh agen nanti. */
export const agentRoutes: FastifyPluginAsyncZod<AgentRouteOptions> = async (app, opts) => {
  const ctx: ToolContext = { db: app.db, now: opts.now, walking: opts.walking };
  const accountOf = new WeakMap<FastifyRequest, string>();
  const limit = (name: string, max: number) => app.createRateLimit({ max, timeWindow: HOUR_MS, keyGenerator: (request) => `${name}:${accountOf.get(request)}` });
  const toolLimit = limit("agen", TOOL_CALLS_PER_HOUR);
  const routeLimit = limit("agen-rute", WALKING_ROUTES_PER_HOUR);

  /** Akun yang boleh memakai agen rute, lalu batas per akun. */
  const member = async (request: FastifyRequest, reply: FastifyReply, limits: ReturnType<typeof limit>[]) => {
    if (!opts.enabled) throw new HttpError(503, "agen_rute_belum_aktif", "Agen rute belum dibuka.");
    if (!opts.auth) throw new HttpError(503, "akun_belum_diatur", "Fitur akun belum diatur di server.");
    const { user } = await requireSession(opts.auth, app.db, request, opts.now);
    if (needsCompletion(user)) throw new HttpError(403, "akun_belum_lengkap", "Lengkapi akun dulu sebelum memakai agen rute.");
    accountOf.set(request, user.id);
    for (const check of limits) {
      const result = await check(request);
      if (!result.isAllowed && result.isExceeded) {
        reply.header("retry-after", Math.ceil(result.ttl / 1000));
        throw new HttpError(429, "agen_terlalu_sering", "Batas pemakaian agen rute untuk akun Anda tercapai. Coba lagi nanti.");
      }
    }
    reply.header("cache-control", "no-store");
  };

  app.get(
    "/agent/tools",
    {
      schema: {
        tags: [TAG],
        summary: "Daftar alat agen rute",
        description: `Nama, deskripsi, dan JSON Schema input setiap alat, untuk disambungkan ke penyedia model yang mendukung tool calling. ${COMMON}`,
        response: { 200: definitions, 401: errorSchema, 403: errorSchema, 429: errorSchema, 503: errorSchema },
      },
    },
    async (request, reply) => {
      await member(request, reply, [toolLimit]);
      return { tools: toolDefinitions() };
    },
  );

  for (const tool of AGENT_TOOLS) {
    app.post(
      `/agent/tools/${tool.name}`,
      {
        schema: {
          tags: [TAG],
          summary: tool.name,
          description: `${tool.description}\n\n${COMMON}${EXTRA[tool.name] ?? ""}`,
          body: tool.input,
          response: {
            200: tool.output,
            400: errorSchema,
            401: errorSchema,
            403: errorSchema,
            404: errorSchema,
            422: errorSchema,
            429: errorSchema,
            502: errorSchema,
            503: errorSchema,
          },
        },
      },
      async (request, reply) => {
        await member(request, reply, tool.name === "walking_route" ? [toolLimit, routeLimit] : [toolLimit]);
        // Setiap alat dipasangkan dengan skema input dan output-nya di registry; serializer Zod memeriksa jawabannya.
        const run = tool.run as (ctx: ToolContext, input: unknown) => Promise<never>;
        return run(ctx, request.body);
      },
    );
  }
};
