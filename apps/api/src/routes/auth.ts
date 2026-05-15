import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../api-context.js";

export function registerAuthRoutes(app: FastifyInstance, context: ApiRouteContext): void {
  app.get("/api/auth/session", async (request) => context.getWebAuth().info(request));

  app.post<{ Body: { username?: string; password?: string } }>("/api/auth/login", async (request, reply) => {
    const body = request.body ?? {};
    return context.getWebAuth().login(String(body.username ?? ""), String(body.password ?? ""), reply);
  });

  app.post("/api/auth/logout", async (request, reply) => context.getWebAuth().logout(request, reply));
}
