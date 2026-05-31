import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../api-context.js";
import { registerAuthRoutes } from "./auth.js";
import { registerBrowserRoutes } from "./browser.js";
import { registerDiagnosticsRoutes } from "./diagnostics.js";
import { registerHealthRoutes } from "./health.js";
import { registerIntakeRoutes } from "./intake.js";
import { registerJobRoutes } from "./jobs.js";
import { registerRssRoutes } from "./rss.js";
import { registerSettingsRoutes } from "./settings.js";

export function registerApiRoutes(app: FastifyInstance, context: ApiRouteContext): void {
  registerAuthRoutes(app, context);
  registerSettingsRoutes(app, context);
  registerRssRoutes(app, context);
  registerHealthRoutes(app, context);
  registerDiagnosticsRoutes(app, context);
  registerJobRoutes(app, context);
  registerIntakeRoutes(app, context);
  registerBrowserRoutes(app, context);
}
