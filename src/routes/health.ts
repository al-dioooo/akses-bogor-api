import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/healthz",
    {
      schema: {
        tags: ["Sistem"],
        summary: "Cek server hidup",
        description: "Dipakai health check Azure App Service. Tidak menyentuh database.",
        response: { 200: z.object({ status: z.literal("ok") }) },
      },
    },
    async () => ({ status: "ok" as const }),
  );
};
