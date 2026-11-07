import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { createAuth } from "./auth/auth.js";
import { scheduleCleanup } from "./auth/cleanup.js";
import type { Env } from "./config/env.js";
import { createDb, type Db } from "./db/client.js";
import { logMailer, resendMailer, type Mailer } from "./email/mailer.js";
import { HttpError } from "./http/errors.js";
import { mapTokenSource } from "./map/token.js";
import { authRoutes } from "./routes/auth.js";
import { districtRoutes } from "./routes/districts.js";
import { healthRoutes } from "./routes/health.js";
import { mapRoutes } from "./routes/map.js";
import { meRoutes } from "./routes/me.js";
import { placeRoutes } from "./routes/places.js";
import { reportRoutes } from "./routes/reports.js";

// Hanya untuk pengembangan lokal tanpa BETTER_AUTH_SECRET. Production tanpa secret mematikan route akun (503).
const DEVELOPMENT_AUTH_SECRET = "rahasia-pengembangan-lokal-aksesbogor-jangan-dipakai-di-production";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
  }
}

/**
 * `deps` dipakai tes: `db` (PGlite), `now` (jam tetap), `fetch` (Mapbox tiruan), dan `mailer` (email ditampung). Tanpa
 * `db`, aplikasi membuka pool ke `DATABASE_URL`.
 */
export async function buildApp(env: Env, deps: { db?: Db; now?: () => Date; fetch?: typeof fetch; mailer?: Mailer } = {}) {
  const now = deps.now ?? (() => new Date());
  const app = Fastify({
    logger:
      env.NODE_ENV === "test"
        ? false
        : {
            level: env.NODE_ENV === "production" ? "info" : "debug",
            redact: ["req.headers.authorization", "req.headers.cookie"],
          },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  if (deps.db) {
    app.decorate("db", deps.db);
  } else {
    const { db, pool } = createDb(env.DATABASE_URL, (error) =>
      app.log.warn({ err: error }, "koneksi database terputus; dibuka ulang saat dibutuhkan"),
    );
    app.decorate("db", db);
    app.addHook("onClose", async () => {
      await pool.end();
    });
  }

  await app.register(swagger, {
    openapi: {
      info: {
        title: "AksesBogor API",
        version: "0.1.0",
        description: "API AksesBogor. Dibuat otomatis dari skema Zod di setiap route.",
      },
    },
    transform: jsonSchemaTransform,
  });

  const allowedOrigins = new Set(env.FRONTEND_ORIGINS);
  const originAllowed = (origin?: string) =>
    !origin || allowedOrigins.has(origin) || (env.NODE_ENV !== "production" && /^http:\/\/localhost:\d+$/.test(origin));
  await app.register(cors, {
    credentials: true,
    origin: (origin, callback) => callback(null, originAllowed(origin)),
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
    allowList: (request) => request.url === "/healthz",
  });

  app.setErrorHandler((error: FastifyError | HttpError, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ galat: error.code, pesan: error.message });
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({ galat: "input_tidak_valid", pesan: "Data yang dikirim tidak sesuai. Periksa lagi isiannya." });
    }
    if (error.statusCode === 429) {
      return reply.code(429).send({ galat: "terlalu_sering", pesan: "Terlalu banyak permintaan. Tunggu sebentar." });
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ galat: "permintaan_tidak_valid", pesan: "Permintaan tidak bisa diproses." });
    }
    request.log.error({ err: error }, "galat tak terduga");
    return reply.code(500).send({ galat: "server", pesan: "Terjadi kesalahan di server. Coba lagi." });
  });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ galat: "tidak_ditemukan", pesan: "Alamat tidak ditemukan." }));

  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
  await app.register(healthRoutes);
  await app.register(districtRoutes);
  await app.register(placeRoutes, { photoBaseUrl: env.PHOTO_PUBLIC_URL, now });
  const { MAPBOX_SECRET_TOKEN: secretToken, MAPBOX_USERNAME: username } = env;
  await app.register(mapRoutes, {
    mapToken: secretToken && username ? mapTokenSource({ secretToken, username, now, fetch: deps.fetch }) : undefined,
  });

  // Akun (ADR-0029) dan email (ADR-0030).
  const development = env.NODE_ENV === "development";
  const mailer =
    deps.mailer ??
    (env.RESEND_API_KEY && env.EMAIL_FROM
      ? resendMailer({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM })
      : development
        ? logMailer((message) => app.log.info(message))
        : undefined);
  const authSecret = env.BETTER_AUTH_SECRET ?? (development ? DEVELOPMENT_AUTH_SECRET : undefined);
  const auth = authSecret
    ? createAuth({
        db: app.db,
        secret: authSecret,
        baseURL: env.BETTER_AUTH_URL ?? `http://localhost:${env.PORT}`,
        googleClientId: env.GOOGLE_CLIENT_ID,
      })
    : undefined;
  await app.register(authRoutes, { auth, mailer, googleEnabled: Boolean(env.GOOGLE_CLIENT_ID), now });
  await app.register(meRoutes, { auth, mailer, now });
  await app.register(reportRoutes);
  if (auth && env.NODE_ENV !== "test") {
    const stop = scheduleCleanup(app.db, now, app.log);
    app.addHook("onClose", async () => stop());
  }

  return app;
}
