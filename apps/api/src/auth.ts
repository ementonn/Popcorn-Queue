import type { FastifyReply, FastifyRequest } from "fastify";

export function makeBrowserAuthHook(browserToken: string) {
  return async function browserAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!browserToken) {
      await reply.code(503).send({ error: "browser_token_not_configured" });
      return;
    }
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : request.headers["x-popcorn-token"];
    if (token !== browserToken) {
      request.log.warn(
        {
          url: request.url,
          hasAuthorizationHeader: Boolean(header),
          hasBrowserTokenHeader: Boolean(request.headers["x-popcorn-token"])
        },
        "browser auth failed"
      );
      await reply.code(401).send({ error: "unauthorized" });
    }
  };
}
