// Optional sign-in for agent-yes.com: Google and/or GitHub via better-auth, on D1.
//
// Sign-in is never required. Rooms, share links and tokens work exactly as they
// do without it; a signed-in session only adds the profile menu, room sync
// (Google, lab/ui/room-sync.js) and the owner's debug chat (GitHub, liagent.ts).
//
// Mounted at /_ay/auth/* on the apex (agent-yes.com, or AUTH_ORIGIN on a
// self-hosted deployment) only, so its cookies never reach the signaling or
// exposure hosts and its routes can't clash with `ay serve`'s /api/*. A provider
// is on only when its own two secrets are set; with none (or without the D1
// binding) the routes answer 503 and the console shows no sign-in at all.
//   wrangler d1 migrations apply agent-yes-auth --remote
//   wrangler secret put BETTER_AUTH_SECRET       (openssl rand -base64 32)
//   wrangler secret put GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET    (optional)
//   wrangler secret put GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET    (optional)
// Redirect URIs: <AUTH_ORIGIN>/_ay/auth/callback/google and .../github.

import { betterAuth } from "better-auth";

export const AUTH_PATH = "/_ay/auth";
export const DEFAULT_AUTH_ORIGIN = "https://agent-yes.com";
/** The site owner: the only account debug mode (and its chat hub) admits. */
export const OWNER_EMAIL = "snomiao@gmail.com";

export interface AuthEnv {
  AUTH_DB?: D1Database;
  BETTER_AUTH_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Override for local `wrangler dev` (e.g. http://localhost:8799). */
  AUTH_ORIGIN?: string;
}

export type Provider = "google" | "github";
export const DRIVE_APPDATA_SCOPE = "https://www.googleapis.com/auth/drive.appdata";

/** The providers this deployment has both secrets for, in display order. */
export function providers(env: AuthEnv): Provider[] {
  const out: Provider[] = [];
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) out.push("google");
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) out.push("github");
  return out;
}

/** The origin auth is served on, or null when this request's host is not it. */
export function authOrigin(env: AuthEnv, host: string): string | null {
  const origin = env.AUTH_ORIGIN || DEFAULT_AUTH_ORIGIN;
  return new URL(origin).host === host ? origin : null;
}

export const authConfigured = (env: AuthEnv): boolean =>
  !!(env.AUTH_DB && env.BETTER_AUTH_SECRET && providers(env).length);

export function authOptions(env: AuthEnv, origin: string) {
  const socialProviders: Record<string, unknown> = {};
  if (providers(env).includes("google"))
    socialProviders.google = {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      scope: [DRIVE_APPDATA_SCOPE],
      // offline + consent: Google only issues a refresh token on a consent
      // screen, and without one room sync would need a new sign-in hourly.
      accessType: "offline",
      prompt: "select_account consent",
    };
  // better-auth reads GitHub's primary email from /user/emails (the user:email
  // scope), with GitHub's own verified flag.
  if (providers(env).includes("github"))
    socialProviders.github = {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    };
  return {
    baseURL: origin,
    basePath: AUTH_PATH,
    secret: env.BETTER_AUTH_SECRET,
    database: env.AUTH_DB,
    trustedOrigins: [origin],
    socialProviders,
    account: { encryptOAuthTokens: true },
    telemetry: { enabled: false },
  };
}

// One instance per isolate: building it parses the config and sets up the
// adapter, which is wasted work on every request.
let cached: { env: AuthEnv; origin: string; auth: ReturnType<typeof betterAuth> } | null = null;

function getAuth(env: AuthEnv, origin: string) {
  if (!cached || cached.env !== env || cached.origin !== origin)
    cached = { env, origin, auth: betterAuth(authOptions(env, origin)) };
  return cached.auth;
}

/** Handle a request under AUTH_PATH. */
export async function handleAuth(req: Request, env: AuthEnv, origin: string): Promise<Response> {
  if (!authConfigured(env))
    return Response.json({ error: "sign-in is not configured" }, { status: 503 });
  // What the console asks before it shows any sign-in UI.
  if (new URL(req.url).pathname === `${AUTH_PATH}/providers`)
    return Response.json(
      { providers: providers(env) },
      { headers: { "Cache-Control": "no-store" } },
    );
  const res = await getAuth(env, origin).handler(req);
  const h = new Headers(res.headers);
  h.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

/** Whether a signed-in user is the site owner: the owner's email, verified by the provider. */
export const isOwner = (user: { email?: string | null; emailVerified?: boolean | null }) =>
  !!user.emailVerified && user.email?.toLowerCase() === OWNER_EMAIL;

/** The signed-in user behind a request's session cookie, or null. */
export async function sessionUser(req: Request, env: AuthEnv, origin: string) {
  if (!authConfigured(env)) return null;
  const s = await getAuth(env, origin).api.getSession({ headers: req.headers });
  return s?.user ?? null;
}
