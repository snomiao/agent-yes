import { betterAuth, type BetterAuthOptions } from "better-auth";
import type { D1Database } from "@better-auth/core";

export const AUTH_ORIGIN = "https://agent-yes.com";
export const AUTH_PATH = "/api/auth";

export interface AuthEnv {
  AUTH_DB?: D1Database;
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

/** Canonical in production; an explicit loopback URL supports local previews. */
export function authOrigin(env: Pick<AuthEnv, "BETTER_AUTH_URL">): string {
  const url = new URL(env.BETTER_AUTH_URL || AUTH_ORIGIN);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.origin !== AUTH_ORIGIN && !(local && ["http:", "https:"].includes(url.protocol)))
  )
    throw new Error("Invalid authentication origin");
  return url.origin;
}

export function authOptions(env: AuthEnv): BetterAuthOptions {
  const baseURL = authOrigin(env);
  const secure = baseURL.startsWith("https:");
  if (
    !env.AUTH_DB ||
    !env.BETTER_AUTH_SECRET ||
    env.BETTER_AUTH_SECRET.length < 32 ||
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET
  ) {
    throw new Error("Authentication is not configured");
  }
  return {
    appName: "agent-yes",
    baseURL,
    basePath: AUTH_PATH,
    secret: env.BETTER_AUTH_SECRET,
    database: env.AUTH_DB,
    trustedOrigins: [baseURL],
    onAPIError: { errorURL: `${baseURL}/auth/` },
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        prompt: "select_account",
      },
    },
    user: { modelName: "auth_user" },
    session: { modelName: "auth_session" },
    account: { modelName: "auth_account", encryptOAuthTokens: true },
    verification: { modelName: "auth_verification" },
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "auth_rate_limit",
      window: 60,
      max: 100,
    },
    advanced: {
      disableOriginCheck: false,
      disableCSRFCheck: false,
      // Better Auth's automatic prefix is __Secure-. Use __Host- instead so
      // an untrusted exposure subdomain cannot set a parent-domain auth cookie.
      // Only the automatic naming is disabled: HTTPS cookies stay Secure.
      cookiePrefix: secure ? "__Host-agent-yes" : "agent-yes",
      useSecureCookies: false,
      defaultCookieAttributes: { secure, httpOnly: true, sameSite: "lax", path: "/" },
      crossSubDomainCookies: { enabled: false },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    // OAuth credentials and profile data must never enter the Worker logs.
    logger: { disabled: true },
    telemetry: { enabled: false },
  };
}

/** Request-local instances avoid sharing D1 execution state across requests. */
export async function authFetch(req: Request, env: AuthEnv): Promise<Response> {
  let origin: string;
  try {
    origin = authOrigin(env);
  } catch {
    return unavailable();
  }
  // Never trust Host/X-Forwarded-Host or wildcard exposure subdomains here.
  if (new URL(req.url).origin !== origin) return new Response("Not found", { status: 404 });
  if (!["GET", "POST"].includes(req.method)) {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
  }
  if (req.method === "POST" && req.headers.get("Origin") !== origin) {
    return Response.json(
      { code: "INVALID_ORIGIN", message: "Invalid request origin." },
      {
        status: 403,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
  try {
    const response = await betterAuth(authOptions(env)).handler(req);
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("Pragma", "no-cache");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return unavailable();
  }
}

function unavailable(): Response {
  return Response.json(
    { code: "AUTH_UNAVAILABLE", message: "Sign-in is temporarily unavailable." },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}
