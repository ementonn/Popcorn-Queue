import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../api-context.js";
import { registerAuthRoutes } from "./auth.js";
import { registerDiagnosticsRoutes } from "./diagnostics.js";
import { registerHealthRoutes } from "./health.js";
import { registerJobRoutes } from "./jobs.js";
import { registerSettingsRoutes } from "./settings.js";

export function registerApiRoutes(app: FastifyInstance, context: ApiRouteContext): void {
  registerAuthRoutes(app, context);
  registerSettingsRoutes(app, context);
  registerHealthRoutes(app, context);
  registerDiagnosticsRoutes(app, context);
  registerJobRoutes(app, context);
}
