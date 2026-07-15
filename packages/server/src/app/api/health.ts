import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  uptimeSeconds: z.number(),
  timestamp: z.string(),
});

// Liveness probe (design §6.2: `GET /health`). Deliberately dumb — no DB or
// dependency checks here yet; those land with the Drizzle/Postgres task.
export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/health",
    {
      schema: {
        response: {
          200: HealthResponseSchema,
        },
      },
    },
    async () => ({
      status: "ok" as const,
      uptimeSeconds: process.uptime(),
      timestamp: new Date().toISOString(),
    }),
  );
};
