import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../api-context.js";
import { loadConfigFromEnvPath, saveSettingsEnv, settingsResponse, type SaveSettingsInput } from "../settings.js";

export function registerSettingsRoutes(app: FastifyInstance, context: ApiRouteContext): void {
  app.get("/api/settings", async () => settingsResponse(context.settingsEnvPath, context.config()));

  app.patch<{ Body: SaveSettingsInput }>("/api/settings", async (request, reply) => {
    try {
      await saveSettingsEnv(context.settingsEnvPath, request.body ?? {});
      context.applyRuntimeConfig(loadConfigFromEnvPath(context.settingsEnvPath));
      return reply.send({
        ...settingsResponse(context.settingsEnvPath, context.config()),
        saved: true,
        reloaded: true,
        restartRequired: false
      });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "settings_save_failed" });
    }
  });
}
