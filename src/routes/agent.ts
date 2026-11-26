import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { askAgent } from "../agent/ask.js";
import { placeCardSchema, routeCardSchema } from "../agent/cards.js";
import { QUESTIONS_PER_ACCOUNT_PER_DAY, dailyLimit, type DailyLimit } from "../agent/limits.js";
import { AgentBusyError, type AgentModel } from "../agent/model.js";
import { AGENT_TOOLS, toolDefinitions } from "../agent/registry.js";
import type { ToolContext } from "../agent/tools.js";
import type { Auth } from "../auth/auth.js";
import { currentSession, needsCompletion, requireSession } from "../auth/session.js";
import { osmFeatureKind } from "../db/schema.js";
import { prioritySchema } from "./districts.js";
import { HttpError, errorSchema } from "../http/errors.js";
import { accessibleRoute, type AccessibleRouteContext } from "../map/accessible-route.js";
import type { WayFlagsSource } from "../map/accessible-ways.js";
import type { WalkingRouter } from "../map/directions.js";
import { ACCESSIBLE_PROFILES, type AccessibleRouter } from "../map/valhalla.js";
import { routeObstacles, walkingRoute, type RouteContext } from "../map/walking-route.js";

const TAG_AGENT = "Agen rute";
const TAG_ROUTE = "Rute jalan kaki";
const HOUR_MS = 60 * 60 * 1000;
/** Permintaan ke semua route agen dan rute per akun per jam: cukup untuk belasan pertanyaan dan beberapa rute. */
export const AGENT_CALLS_PER_HOUR = 120;
/** Rute jalan kaki per akun per jam; setiap rute memakai satu permintaan Mapbox Directions. */
export const WALKING_ROUTES_PER_HOUR = 30;
/** Rute OpenStreetMap per akun per jam; Valhalla berjalan di host sendiri, jadi batas ini menjaga beban server. */
export const ACCESSIBLE_ROUTES_PER_HOUR = 30;

export type AgentRouteOptions = {
  /** Kosong bila `BETTER_AUTH_SECRET` belum diatur di production. */
  auth?: Auth;
  /** `ROUTE_AGENT_ENABLED`. Mati sampai syarat peluncuran di ADR-0042 terpenuhi. */
  enabled: boolean;
  /** Kosong bila `MAPBOX_SECRET_TOKEN` belum diatur. */
  walking?: WalkingRouter;
  /** Kosong bila `ACCESSIBLE_ROUTER_URL` belum diatur: `POST /route/accessible` menjawab 503 (ADR-0055). */
  accessible?: { router: AccessibleRouter; ways?: WayFlagsSource };
  /** `DISABILITY_DATA_ENABLED`: alat prioritas kecamatan boleh memakai data disabilitas (ADR-0043). */
  disabilityData?: boolean;
  /** Model agen (`provider.ts`); kosong bila OpenRouter dipilih tanpa API key, dan `POST /agent/ask` menjawab sibuk. */
  model?: AgentModel;
  /**
   * `ROUTE_ASSISTANT_ENABLED` (ADR-0050): rute jalan kaki ke lokasi AksesBogor dan hambatannya boleh dipakai tanpa akun,
   * dengan batas per IP dari `visitorKey`.
   */
  assistantEnabled?: boolean;
  visitorKey?: (request: FastifyRequest) => string;
  /** Jatah pertanyaan per akun per hari, satu hitungan dengan asisten rute publik. */
  accountQuestions?: DailyLimit;
  now: () => Date;
};

const definitions = z.object({
  tools: z.array(
    z.object({
      type: z.literal("function"),
      function: z.object({ name: z.string(), description: z.string(), parameters: z.record(z.string(), z.unknown()).describe("JSON Schema parameter alat") }),
    }),
  ),
});

const location = z.object({ lat: z.number(), lng: z.number() });
const routeTarget = z
  .object({
    from: z
      .object({ lat: z.number().min(-90).max(90).describe("Lintang (derajat, WGS 84)"), lng: z.number().min(-180).max(180).describe("Bujur (derajat, WGS 84)") })
      .describe("Posisi pengguna saat ini, dari browser atau titik yang dipilih di peta"),
    placeId: z.uuid().optional().describe("Id lokasi AksesBogor tujuan"),
    osm: z
      .object({ type: z.enum(["node", "way", "relation"]), id: z.number().int() })
      .optional()
      .describe("Atau tempat OpenStreetMap tanpa data AksesBogor, dari kartu rute agen untuk kontributor (ADR-0043)"),
  });
const oneTarget = (body: { placeId?: string; osm?: unknown }) => Boolean(body.placeId) !== Boolean(body.osm);
const walkingBody = routeTarget.refine(oneTarget, { message: "Isi placeId atau osm, salah satu" });
const walkingResponse = z.object({
  destination: z.object({
    placeId: z.uuid().nullable(),
    osm: z.object({ type: z.string(), id: z.number().int() }).nullable(),
    name: z.string().nullable(),
    location,
  }),
  distanceMeters: z.number().int(),
  durationSeconds: z.number().int(),
  steps: z.array(
    z.object({ instruction: z.string(), distanceMeters: z.number().int(), durationSeconds: z.number().int(), name: z.string().nullable(), maneuver: z.string(), location }),
  ),
  geometry: z.object({ type: z.literal("LineString"), coordinates: z.array(z.tuple([z.number(), z.number()])) }).describe("GeoJSON [bujur, lintang]"),
  polyline: z.string().describe("Garis rute sebagai polyline presisi 6, untuk POST /route/obstacles"),
  warning: z.string().describe("Kalimat peringatan tetap yang selalu ditampilkan bersama rute"),
  attribution: z.string(),
});
const accessibleBody = routeTarget
  .extend({ profil: z.enum(ACCESSIBLE_PROFILES).describe("`kursi_roda`: tanpa tangga dan lebih memilih trotoar. `jalan_kaki`: pejalan kaki biasa") })
  .refine(oneTarget, { message: "Isi placeId atau osm, salah satu" });
const accessibleResponse = walkingResponse.omit({ warning: true }).extend({
  profil: z.enum(ACCESSIBLE_PROFILES),
  coverage: z
    .object({
      sidewalkPercent: z.number().int().nullable().describe("Persen panjang rute di jalur pejalan kaki atau jalan yang trotoarnya tercatat di OSM"),
      surfacePercent: z.number().int().nullable().describe("Persen panjang rute yang jenis permukaannya tercatat"),
      crossings: z.number().int().nullable().describe("Jalur penyeberangan OSM yang dilewati"),
      crossingsWithKerb: z.number().int().nullable().describe("Penyeberangan yang kerb-nya tercatat"),
      dataDate: z.string().nullable().describe("Tanggal ekstrak OSM yang dipakai"),
    })
    .describe("Cakupan data OSM di sepanjang rute; null bila tidak bisa dihitung"),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })).describe("Peringatan untuk ditampilkan bersama rute, urut dari hambatan lalu kekurangan data"),
  note: z.string().describe("Label tetap: rute dihitung dari data OpenStreetMap dan kondisi lapangan bisa berbeda"),
});
const obstaclesBody = z.object({
  polyline: z.string().min(2).max(60_000).describe("Nilai `polyline` dari POST /route/walking atau POST /route/accessible"),
  bufferMeters: z.number().int().min(5).max(50).optional().describe("Jarak paling jauh dari garis rute, dalam meter; bawaan 20"),
});
const obstaclesResponse = z.object({
  bufferMeters: z.number().int(),
  truncated: z.boolean().describe("Benar bila lebih dari 50 fitur cocok dan hanya 50 pertama yang dikirim"),
  features: z.array(
    z.object({
      kind: z.enum(osmFeatureKind.enumValues),
      description: z.string(),
      name: z.string().nullable(),
      tags: z.record(z.string(), z.string()),
      distanceFromRouteMeters: z.number().int(),
      alongRouteMeters: z.number().int().describe("Jarak dari awal rute ke titik terdekat dengan fitur ini"),
      osm: z.object({ type: z.string(), id: z.number().int(), url: z.url() }),
    }),
  ),
  note: z.string(),
  attribution: z.string(),
});

const askBody = z.object({
  placeId: z.uuid().optional().describe("Id lokasi AksesBogor bila pengguna bertanya dari halaman tempat itu"),
  question: z.string().trim().min(2).max(500).describe("Pertanyaan pengguna"),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(1000) }))
    .max(6)
    .optional()
    .describe("Giliran sebelumnya yang disimpan browser selama halaman terbuka; server tidak menyimpannya"),
});
const askResponse = z.object({
  answer: z.string().describe("Jawaban agen dalam bahasa Indonesia"),
  sources: z
    .array(
      z.discriminatedUnion("type", [
        z.object({
          type: z.literal("lokasi"),
          placeId: z.uuid(),
          name: z.string(),
          lastVerifiedAt: z.iso.datetime(),
          verifiedBy: z.enum(["tim", "admin"]).describe("`admin`: diterbitkan langsung oleh admin, web tidak menyebutnya terverifikasi (ADR-0051)"),
          verificationSource: z.enum(["laporan", "street_view"]).describe("`street_view`: web menulis \"diverifikasi dari Street View\" dengan bulan gambarnya (ADR-0057)"),
          streetViewImageDate: z.string().nullable().describe("Bulan gambar Street View, `YYYY-MM`"),
        }),
        z.object({ type: z.literal("pengetahuan"), citation: z.string(), title: z.string(), url: z.url(), license: z.string(), attribution: z.string().nullable() }),
      ]),
    )
    .describe("Data terverifikasi AksesBogor dan potongan basis pengetahuan yang dibaca agen untuk jawaban ini"),
  model: z.string().nullable().describe("Model yang menjawab, mis. claude-haiku-5-5"),
  cards: z
    .array(z.union([placeCardSchema, routeCardSchema, prioritySchema.extend({ type: z.literal("prioritas") })]))
    .describe("Kartu untuk ditampilkan web di bawah jawaban: tempat, rute (dihitung web dari posisi pengguna), atau prioritas kecamatan. Isinya tidak dikirim ke model"),
});

const errors = { 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema, 422: errorSchema, 429: errorSchema, 502: errorSchema, 503: errorSchema };
const COMMON =
  "Hanya untuk akun yang sudah masuk dan melengkapi akun (ADR-0042). Menjawab 503 `agen_rute_belum_aktif` selama `ROUTE_AGENT_ENABLED` mati. Semua route agen dan rute berbagi batas 120 permintaan per akun per jam. Data dikirim di badan permintaan supaya tidak tercatat di log.";
const VISITORS =
  "Selama `ROUTE_ASSISTANT_ENABLED` menyala, route ini juga untuk pengunjung tanpa akun asisten rute publik, untuk lokasi AksesBogor dan kandidat OpenStreetMap, dengan batas per IP (ADR-0050).";
const APP_ONLY = "Dipanggil browser pengguna sendiri dan hasilnya hanya ditampilkan kepadanya; tidak pernah dikirim ke model (Product Terms Mapbox §1.5).";

/**
 * Agen rute (ADR-0042) dengan dua jenis pemanggil. `/agent/tools/*` adalah alat untuk model, tanpa posisi pengguna.
 * `/route/*` adalah rute jalan kaki dan hambatan di dekatnya untuk browser pengguna, tidak pernah untuk model.
 */
export const agentRoutes: FastifyPluginAsyncZod<AgentRouteOptions> = async (app, opts) => {
  const toolCtx: ToolContext = { db: app.db, now: opts.now, disabilityData: opts.disabilityData };
  const routeCtx: RouteContext = { db: app.db, now: opts.now, walking: opts.walking };
  const accountOf = new WeakMap<FastifyRequest, string>();
  const limit = (name: string, max: number) => app.createRateLimit({ max, timeWindow: HOUR_MS, keyGenerator: (request) => `${name}:${accountOf.get(request)}` });
  const agentLimit = limit("agen", AGENT_CALLS_PER_HOUR);
  const questionLimit = opts.accountQuestions ?? dailyLimit(QUESTIONS_PER_ACCOUNT_PER_DAY, opts.now, 7);
  const busy = () => new HttpError(503, "agen_sibuk", "Agen sedang sibuk, coba lagi nanti.");
  const walkingLimit = limit("agen-rute", WALKING_ROUTES_PER_HOUR);
  const accessibleLimit = limit("rute-aksesibel", ACCESSIBLE_ROUTES_PER_HOUR);
  const accessibleCtx: AccessibleRouteContext = { db: app.db, now: opts.now, router: opts.accessible?.router, ways: opts.accessible?.ways };

  /** Batas per akun, atau per IP untuk pengunjung asisten rute publik. */
  const checkLimits = async (request: FastifyRequest, reply: FastifyReply, limits: ReturnType<typeof limit>[]) => {
    for (const check of limits) {
      const result = await check(request);
      if (!result.isAllowed && result.isExceeded) {
        reply.header("retry-after", Math.ceil(result.ttl / 1000));
        throw new HttpError(429, "agen_terlalu_sering", "Batas pemakaian agen rute untuk akun Anda tercapai. Coba lagi nanti.");
      }
    }
    reply.header("cache-control", "no-store");
  };

  /** Akun yang boleh memakai agen rute, lalu batas per akun. */
  const member = async (request: FastifyRequest, reply: FastifyReply, limits: ReturnType<typeof limit>[]) => {
    if (!opts.enabled) throw new HttpError(503, "agen_rute_belum_aktif", "Agen rute belum dibuka.");
    if (!opts.auth) throw new HttpError(503, "akun_belum_diatur", "Fitur akun belum diatur di server.");
    const { user } = await requireSession(opts.auth, app.db, request, opts.now);
    if (needsCompletion(user)) throw new HttpError(403, "akun_belum_lengkap", "Lengkapi akun dulu sebelum memakai agen rute.");
    accountOf.set(request, user.id);
    await checkLimits(request, reply, limits);
  };

  /**
   * Pemanggil rute jalan kaki dan hambatan. Selama asisten rute publik dibuka (ADR-0050), siapa pun boleh meminta rute
   * ke lokasi AksesBogor atau kandidat OpenStreetMap (ADR-0049): akun yang lengkap dihitung per akun, yang lain per IP.
   */
  const routeCaller = async (request: FastifyRequest, reply: FastifyReply, limits: ReturnType<typeof limit>[]) => {
    if (!opts.assistantEnabled || !opts.visitorKey) return member(request, reply, limits);
    const session = opts.auth && request.headers.authorization ? await currentSession(opts.auth, app.db, request, opts.now) : null;
    accountOf.set(request, session && !needsCompletion(session.user) ? session.user.id : `ip:${opts.visitorKey(request)}`);
    await checkLimits(request, reply, limits);
  };

  app.get(
    "/agent/tools",
    {
      schema: {
        tags: [TAG_AGENT],
        summary: "Daftar alat untuk model",
        description: `Larik \`tools\` format OpenAI (type, nama, deskripsi, dan JSON Schema parameter) untuk alat yang boleh dipanggil model. ${COMMON}`,
        response: { 200: definitions, 401: errorSchema, 403: errorSchema, 429: errorSchema, 503: errorSchema },
      },
    },
    async (request, reply) => {
      await member(request, reply, [agentLimit]);
      return { tools: toolDefinitions() };
    },
  );

  for (const tool of AGENT_TOOLS) {
    app.post(
      `/agent/tools/${tool.name}`,
      {
        schema: { tags: [TAG_AGENT], summary: tool.name, description: `${tool.description}\n\n${COMMON}`, body: tool.input, response: { 200: tool.output, ...errors } },
      },
      async (request, reply) => {
        await member(request, reply, [agentLimit]);
        // Setiap alat dipasangkan dengan skema input dan output-nya di registry; serializer Zod memeriksa jawabannya.
        const run = tool.run as (ctx: ToolContext, input: unknown) => Promise<never>;
        return run(toolCtx, request.body);
      },
    );
  }

  app.post(
    "/route/walking",
    {
      schema: {
        tags: [TAG_ROUTE],
        summary: "Rute jalan kaki ke pin lokasi",
        description: `Rute jalan kaki Mapbox dari posisi pengguna ke pin lokasi (biasanya pintu masuk utama): jarak, waktu, langkah, garis rute, kalimat peringatan tetap, dan atribusi. Profil jalan kaki tidak memperhitungkan tangga, kerb, atau kemiringan, jadi antarmuka selalu menampilkan \`warning\`. Posisi dibulatkan ke 4 desimal sebelum dikirim ke Mapbox Directions, harus di dalam Kota Bogor dan paling jauh 10 km dari tujuan, dan jawaban Mapbox tidak disimpan. ${APP_ONLY}\n\n${COMMON} ${VISITORS} Batas tambahan 30 rute per akun atau per IP per jam dan 1.000 rute per hari untuk semua pengguna.`,
        body: walkingBody,
        response: { 200: walkingResponse, ...errors },
      },
    },
    async (request, reply) => {
      await routeCaller(request, reply, [agentLimit, walkingLimit]);
      return walkingRoute(routeCtx, request.body);
    },
  );

  app.post(
    "/route/accessible",
    {
      schema: {
        tags: [TAG_ROUTE],
        summary: "Rute pejalan kaki dari data OpenStreetMap",
        description: `Rute dari Valhalla di server AksesBogor sendiri, dengan data OpenStreetMap Kota Bogor (ADR-0055): profil \`kursi_roda\` (tanpa tangga, lebih memilih trotoar dan jalur pejalan kaki) atau \`jalan_kaki\`. Jawabannya memuat jarak, waktu, langkah dalam bahasa Indonesia, garis rute, cakupan data trotoar, permukaan, dan kerb, peringatan, label tetap \`note\`, dan atribusi OSM. Rute tidak pernah dijamin bisa dilewati. Menjawab 503 \`rute_aksesibel_belum_aktif\` selama \`ACCESSIBLE_ROUTER_URL\` kosong; API tidak menggantinya dengan rute Mapbox. 422 \`tanpa_rute_kursi_roda\` bila profil kursi roda tidak menemukan jalur. Posisi dibulatkan ke 4 desimal, harus di dalam Kota Bogor dan paling jauh 10 km dari tujuan, dan tidak disimpan. Dipanggil browser pengguna sendiri dan hasilnya hanya ditampilkan kepadanya; tidak pernah dikirim ke model.\n\n${COMMON} ${VISITORS} Batas tambahan ${ACCESSIBLE_ROUTES_PER_HOUR} rute per akun atau per IP per jam.`,
        body: accessibleBody,
        response: { 200: accessibleResponse, ...errors },
      },
    },
    async (request, reply) => {
      // Diperiksa sebelum batas pemakaian, supaya web bisa tahu fitur ini mati tanpa memakai jatah.
      if (!opts.accessible) throw new HttpError(503, "rute_aksesibel_belum_aktif", "Rute dari data OpenStreetMap belum diatur di server.");
      await routeCaller(request, reply, [agentLimit, accessibleLimit]);
      return accessibleRoute(accessibleCtx, request.body);
    },
  );

  app.post(
    "/route/obstacles",
    {
      schema: {
        tags: [TAG_ROUTE],
        summary: "Hambatan OpenStreetMap di dekat rute",
        description: `Tangga, kerb, ramp, lift, pintu masuk, dan guiding block yang tercatat di OpenStreetMap dalam 20 m (paling jauh 50 m) dari garis rute, urut dari awal rute, dengan tautan ke OSM. Data OSM bisa tidak lengkap; daftar kosong bukan berarti jalannya bebas hambatan. ${APP_ONLY}\n\n${COMMON} ${VISITORS}`,
        body: obstaclesBody,
        response: { 200: obstaclesResponse, ...errors },
      },
    },
    async (request, reply) => {
      await routeCaller(request, reply, [agentLimit]);
      return routeObstacles(routeCtx, request.body);
    },
  );

  app.post(
    "/agent/ask",
    {
      schema: {
        tags: [TAG_AGENT],
        summary: "Bertanya kepada agen AksesBogor untuk kontributor",
        description: `Pertanyaan kontributor: tempat yang perlu dipetakan, jawaban fasilitas terverifikasi, regulasi, aturan AksesBogor, dan cara melapor (ADR-0043). Penyandang disabilitas yang menanyakan rute aksesibel atau tempat tanpa data terverifikasi mendapat jawaban bahwa datanya belum tersedia. Model hanya menerima pertanyaan, giliran sebelumnya, data tempat, dan hasil alat, tidak pernah posisi pengguna atau rute. Tidak ada percakapan yang disimpan. Menjawab 503 \`agen_sibuk\` bila batas harian semua pengguna atau saldo penyedia model habis, API key belum diatur, atau model gagal, dan 429 setelah ${QUESTIONS_PER_ACCOUNT_PER_DAY} pertanyaan per akun per hari WIB.\n\n${COMMON}`,
        body: askBody,
        response: { 200: askResponse, ...errors },
      },
    },
    async (request, reply) => {
      await member(request, reply, [agentLimit]);
      if (!opts.model) throw busy();
      const account = accountOf.get(request)!;
      if (!questionLimit.take(account)) {
        throw new HttpError(429, "agen_terlalu_sering", `Batas ${QUESTIONS_PER_ACCOUNT_PER_DAY} pertanyaan per hari untuk akun Anda tercapai. Coba lagi besok.`);
      }
      try {
        return await askAgent({ model: opts.model, ctx: toolCtx }, request.body);
      } catch (error) {
        // Pertanyaan yang tidak terjawab tidak memakai jatah harian akun.
        questionLimit.give(account);
        if (error instanceof AgentBusyError) {
          request.log.warn({ alasan: error.reason }, "agen rute sibuk");
          throw busy();
        }
        throw error;
      }
    },
  );
};
