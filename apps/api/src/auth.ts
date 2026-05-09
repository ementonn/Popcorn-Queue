import type { FastifyReply, FastifyRequest } from "fastify";
import crypto from "node:crypto";

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

export interface WebAuthConfig {
  enabled: boolean;
  username: string;
  password: string;
  sessionCookieName: string;
  sessionMaxAgeSeconds: number;
}

export interface WebSessionInfo {
  authRequired: boolean;
  authenticated: boolean;
  username: string | null;
}

interface WebSession {
  username: string;
  expiresAt: number;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (!name || !valueParts.length) continue;
    cookies.set(name, decodeURIComponent(valueParts.join("=")));
  }
  return cookies;
}

function cookieValue(request: FastifyRequest, name: string): string | null {
  return parseCookieHeader(request.headers.cookie).get(name) ?? null;
}

function setSessionCookie(reply: FastifyReply, name: string, value: string, maxAgeSeconds: number): void {
  reply.header("Set-Cookie", `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`);
}

function clearSessionCookie(reply: FastifyReply, name: string): void {
  reply.header("Set-Cookie", `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export class WebSessionAuth {
  private readonly sessions = new Map<string, WebSession>();

  constructor(private readonly config: WebAuthConfig) {}

  info(request: FastifyRequest): WebSessionInfo {
    if (!this.config.enabled) return { authRequired: false, authenticated: true, username: null };
    const session = this.sessionForRequest(request);
    return {
      authRequired: true,
      authenticated: Boolean(session),
      username: session?.username ?? null
    };
  }

  async login(username: string, password: string, reply: FastifyReply): Promise<WebSessionInfo> {
    if (!this.config.enabled) return { authRequired: false, authenticated: true, username: null };
    if (!this.config.username || !this.config.password) {
      await reply.code(503).send({ error: "web_auth_not_configured" });
      return { authRequired: true, authenticated: false, username: null };
    }
    if (!safeEqual(username, this.config.username) || !safeEqual(password, this.config.password)) {
      await reply.code(401).send({ error: "invalid_credentials" });
      return { authRequired: true, authenticated: false, username: null };
    }

    const token = crypto.randomBytes(32).toString("base64url");
    this.sessions.set(token, {
      username: this.config.username,
      expiresAt: Date.now() + this.config.sessionMaxAgeSeconds * 1000
    });
    setSessionCookie(reply, this.config.sessionCookieName, token, this.config.sessionMaxAgeSeconds);
    return { authRequired: true, authenticated: true, username: this.config.username };
  }

  logout(request: FastifyRequest, reply: FastifyReply): WebSessionInfo {
    const token = cookieValue(request, this.config.sessionCookieName);
    if (token) this.sessions.delete(token);
    clearSessionCookie(reply, this.config.sessionCookieName);
    return { authRequired: this.config.enabled, authenticated: false, username: null };
  }

  hook() {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!this.config.enabled || this.isPublicApiPath(request)) return;
      if (this.sessionForRequest(request)) return;
      await reply.code(401).send({ error: "web_auth_required" });
    };
  }

  private sessionForRequest(request: FastifyRequest): WebSession | null {
    const token = cookieValue(request, this.config.sessionCookieName);
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  private isPublicApiPath(request: FastifyRequest): boolean {
    if (request.method === "OPTIONS") return true;
    if (!request.url.startsWith("/api/")) return true;
    return request.url.startsWith("/api/auth/") || request.url === "/api/health" || request.url === "/api/features" || request.url.startsWith("/api/browser/");
  }
}
