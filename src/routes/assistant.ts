import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { askAgent } from "../agent/ask.js";
import { ASSISTANT_PROFILE } from "../agent/assistant-prompt.js";
import { routeCardSchema } from "../agent/cards.js";
import { QUESTIONS_PER_ACCOUNT_PER_DAY, QUESTIONS_PER_VISITOR_PER_DAY, dailyLimit, type DailyLimit } from "../agent/limits.js";
import { AgentBusyError, type AgentModel } from "../agent/model.js";
import type { ToolContext } from "../agent/tools.js";
import type { Auth } from "../auth/auth.js";
import { currentSession, needsCompletion } from "../auth/session.js";
import { HttpError, errorSchema } from "../http/errors.js";

const TAG = "Asisten rute publik";
const HOUR_MS = 60 * 60 * 1000;
/** Permintaan ke route asisten per akun atau per IP per jam, sama dengan batas route agen (ADR-0042). */
export const ASSISTANT_CALLS_PER_HOUR = 120;

export type AssistantRouteOptions = {
  /** Kosong bila `BETTER_AUTH_SECRET` belum diatur; semua penanya dianggap pengunjung tanpa akun. */
  auth?: Auth;
  /** `ROUTE_ASSISTANT_ENABLED` (ADR-0050). */
  enabled: boolean;
  /** Model asisten, tanpa hitungan `AGENT_REQUESTS_PER_DAY` milik Bantu memetakan. Kosong berarti sibuk. */
  model?: AgentModel;
  /** `ROUTE_ASSISTANT_QUESTIONS_PER_DAY`: pertanyaan untuk semua penanya per hari WIB. */
  questionsPerDay: number;
  /** Jatah harian per akun, satu hitungan dengan `POST /agent/ask`. */
  accountQuestions: DailyLimit;
  /** Kunci rate limit pengunjung (IP dari server web atau Cloudflare), dari `createRateLimitKey`. */
  visitorKey: (request: FastifyRequest) => string;
  now: () => Date;
};

const point = z
  .object({ lat: z.number().min(-90).max(90).describe("Lintang (derajat, WGS 84)"), lng: z.number().min(-180).max(180).describe("Bujur (derajat, WGS 84)") })
  .describe("Titik awal pengunjung dari browser atau titik yang dipilih di peta. Hanya dipakai server untuk tempat terdekat; tidak pernah dikirim ke model");
const askBody = z.object({
  placeId: z.uuid().optional().describe('Id lokasi AksesBogor bila pengunjung datang dari "Tanya rute ke sini"'),
  question: z.string().trim().min(2).max(500).describe("Pertanyaan pengunjung"),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(1000) }))
    .max(6)
    .optional()
    .describe("Giliran sebelumnya yang disimpan browser selama halaman terbuka; server tidak menyimpannya"),
  from: point.optional(),
});
const askResponse = z.object({
  answer: z.string().describe("Jawaban asisten dalam bahasa Indonesia"),
  sources: z
    .array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("lokasi"), placeId: z.uuid(), name: z.string(), lastVerifiedAt: z.iso.datetime() }),
        z.object({ type: z.literal("pengetahuan"), citation: z.string(), title: z.string(), url: z.url(), license: z.string(), attribution: z.string().nullable() }),
      ]),
    )
    .describe("Data AksesBogor dan potongan basis pengetahuan yang dibaca asisten untuk jawaban ini"),
  model: z.string().nullable().describe("Model yang menjawab, mis. claude-haiku-5-5"),
  cards: z.array(routeCardSchema).describe("Kartu rute jalan kaki untuk ditampilkan web; web menghitung rutenya dari titik awal pengunjung"),
});
const status = z.object({
  enabled: z.boolean().describe("Asisten dibuka (`ROUTE_ASSISTANT_ENABLED`)"),
  questionsPerDay: z.number().int().describe("Jatah pertanyaan per pengunjung atau per akun per hari WIB"),
});

/**
 * Asisten rute publik (ADR-0050): siapa pun, dengan atau tanpa akun, bertanya cara ke lokasi AksesBogor dan mendapat
 * jawaban beserta kartu rute. Akun yang sudah lengkap memakai jatah akun; yang lain memakai jatah per IP.
 */
export const assistantRoutes: FastifyPluginAsyncZod<AssistantRouteOptions> = async (app, opts) => {
  const keyOf = new WeakMap<FastifyRequest, string>();
  const hourly = app.createRateLimit({ max: ASSISTANT_CALLS_PER_HOUR, timeWindow: HOUR_MS, keyGenerator: (request) => `asisten:${keyOf.get(request)}` });
  const visitorQuestions = dailyLimit(QUESTIONS_PER_VISITOR_PER_DAY, opts.now, 7);
  const everyone = dailyLimit(opts.questionsPerDay, opts.now, 7);
  const busy = () => new HttpError(503, "agen_sibuk", "Asisten sedang sibuk. Coba lagi nanti.");

  app.get(
    "/route-assistant/status",
    {
      schema: {
        tags: [TAG],
        summary: "Apakah asisten rute publik dibuka",
        description: "Dipakai web untuk menampilkan halaman Tanya rute atau pesan belum dibuka. Tanpa sesi.",
        response: { 200: status },
      },
    },
    async () => ({ enabled: opts.enabled, questionsPerDay: QUESTIONS_PER_VISITOR_PER_DAY }),
  );

  app.post(
    "/route-assistant/ask",
    {
      schema: {
        tags: [TAG],
        summary: "Bertanya rute kepada asisten AksesBogor",
        description: `Pertanyaan siapa pun tentang cara ke lokasi AksesBogor, lokasi terdekat, dan data aksesibilitasnya (ADR-0050). Model hanya menerima pertanyaan, giliran sebelumnya, data lokasi, hasil alat, dan apakah titik awal ada; tidak pernah titik awal itu sendiri, koordinat, atau rute. Titik awal dibulatkan ke 4 desimal untuk jarak garis lurus ke lokasi terdekat, tidak disimpan, dan tidak dicatat. Tidak ada percakapan yang disimpan.\n\nAkun yang sudah masuk dan lengkap memakai jatah ${QUESTIONS_PER_ACCOUNT_PER_DAY} pertanyaan per akun per hari WIB, satu hitungan dengan \`POST /agent/ask\`; penanya lain ${QUESTIONS_PER_VISITOR_PER_DAY} pertanyaan per IP per hari WIB. Jatah habis dijawab 429 \`kuota_habis\`. Menjawab 503 \`agen_sibuk\` bila batas harian semua penanya (\`ROUTE_ASSISTANT_QUESTIONS_PER_DAY\`) habis, API key belum diatur, atau model gagal, dan 503 \`asisten_rute_belum_aktif\` selama \`ROUTE_ASSISTANT_ENABLED\` mati. Batas tambahan ${ASSISTANT_CALLS_PER_HOUR} permintaan per akun atau per IP per jam.`,
        body: askBody,
        response: { 200: askResponse, 400: errorSchema, 404: errorSchema, 429: errorSchema, 503: errorSchema },
      },
    },
    async (request, reply) => {
      if (!opts.enabled) throw new HttpError(503, "asisten_rute_belum_aktif", "Asisten rute belum dibuka.");
      const session = opts.auth && request.headers.authorization ? await currentSession(opts.auth, app.db, request, opts.now) : null;
      const account = session && !needsCompletion(session.user) ? session.user.id : undefined;
      const key = account ?? opts.visitorKey(request);
      keyOf.set(request, account ? `akun:${account}` : `ip:${key}`);
      const hour = await hourly(request);
      if (!hour.isAllowed && hour.isExceeded) {
        reply.header("retry-after", Math.ceil(hour.ttl / 1000));
        throw new HttpError(429, "agen_terlalu_sering", "Terlalu banyak permintaan ke asisten. Coba lagi nanti.");
      }
      reply.header("cache-control", "no-store");
      if (!opts.model) throw busy();

      const quota = account ? opts.accountQuestions : visitorQuestions;
      if (!quota.take(key)) {
        const limit = account ? QUESTIONS_PER_ACCOUNT_PER_DAY : QUESTIONS_PER_VISITOR_PER_DAY;
        const hint = account ? "" : ", atau masuk untuk memakai jatah akun Anda";
        throw new HttpError(429, "kuota_habis", `Jatah ${limit} pertanyaan hari ini sudah habis. Coba lagi besok${hint}.`);
      }
      if (!everyone.take()) {
        quota.give(key);
        throw busy();
      }
      const { from, ...question } = request.body;
      const ctx: ToolContext = { db: app.db, now: opts.now, position: from };
      try {
        const result = await askAgent({ model: opts.model, ctx, profile: ASSISTANT_PROFILE }, question);
        return { ...result, cards: result.cards.filter((card) => card.type === "rute") };
      } catch (error) {
        // Pertanyaan yang tidak terjawab tidak memakai jatah.
        quota.give(key);
        everyone.give();
        if (error instanceof AgentBusyError) {
          request.log.warn({ alasan: error.reason }, "asisten rute sibuk");
          throw busy();
        }
        throw error;
      }
    },
  );
};
