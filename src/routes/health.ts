import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/healthz",
    {
      schema: {
        tags: ["Sistem"],
        summary: "Cek server hidup",
        description: "Dipakai untuk memantau server dan mengecek deploy. Tidak menyentuh database.",
        response: { 200: z.object({ status: z.literal("ok") }) },
      },
    },
    async () => ({ status: "ok" as const }),
  );
};
