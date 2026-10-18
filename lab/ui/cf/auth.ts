// Optional Google sign-in for "Sync my rooms" (lab/ui/room-sync.js).
//
// better-auth, mounted at /_ay/auth/* on the apex (agent-yes.com) only, so its
// cookies never reach the signaling or exposure hosts and its routes can't clash
// with `ay serve`'s /api/*. Its one job is to hand the console a short-lived
// Google access token for the user's Drive app folder: sign-in asks for the
// drive.appdata scope with offline access, better-auth keeps the refresh token
// (encrypted at rest with BETTER_AUTH_SECRET) and refreshes on /get-access-token.
// The rooms list itself is end-to-end encrypted in the browser and goes straight
// to Google Drive; it never passes through this Worker.
//
// Everything is opt-in: without the D1 binding and all three secrets the auth
// routes answer 503 and the console hides the sync controls.
//   wrangler d1 create agent-yes-auth            (then add the binding to wrangler.jsonc)
//   wrangler d1 migrations apply agent-yes-auth --remote
//   wrangler secret put BETTER_AUTH_SECRET       (openssl rand -base64 32)
//   wrangler secret put GOOGLE_CLIENT_ID
//   wrangler secret put GOOGLE_CLIENT_SECRET
// The Google OAuth client's redirect URI is <AUTH_ORIGIN>/_ay/auth/callback/google.

import { betterAuth } from "better-auth";

export const AUTH_PATH = "/_ay/auth";
export const DEFAULT_AUTH_ORIGIN = "https://agent-yes.com";
export const DRIVE_APPDATA_SCOPE = "https://www.googleapis.com/auth/drive.appdata";

export interface AuthEnv {
  AUTH_DB?: D1Database;
  BETTER_AUTH_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Override for local `wrangler dev` (e.g. http://localhost:8799). */
  AUTH_ORIGIN?: string;
}

/** The origin auth is served on, or null when this request's host is not it. */
export function authOrigin(env: AuthEnv, host: string): string | null {
  const origin = env.AUTH_ORIGIN || DEFAULT_AUTH_ORIGIN;
  return new URL(origin).host === host ? origin : null;
}

export const authConfigured = (env: AuthEnv): boolean =>
  !!(env.AUTH_DB && env.BETTER_AUTH_SECRET && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

export function authOptions(env: Required<Omit<AuthEnv, "AUTH_ORIGIN">>, origin: string) {
  return {
    baseURL: origin,
    basePath: AUTH_PATH,
    secret: env.BETTER_AUTH_SECRET,
    database: env.AUTH_DB,
    trustedOrigins: [origin],
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        scope: [DRIVE_APPDATA_SCOPE],
        // offline + consent: Google only issues a refresh token on a consent
        // screen, and without one the console would need a new sign-in hourly.
        accessType: "offline" as const,
        prompt: "select_account consent" as const,
      },
    },
    account: { encryptOAuthTokens: true },
    telemetry: { enabled: false },
  };
}

// One instance per isolate: building it parses the config and sets up the
// adapter, which is wasted work on every request.
let cached: { env: AuthEnv; origin: string; auth: ReturnType<typeof betterAuth> } | null = null;

/** Handle a request under AUTH_PATH. */
export async function handleAuth(req: Request, env: AuthEnv, origin: string): Promise<Response> {
  if (!authConfigured(env))
    return Response.json({ error: "room sync is not configured" }, { status: 503 });
  if (!cached || cached.env !== env || cached.origin !== origin)
    cached = {
      env,
      origin,
      auth: betterAuth(authOptions(env as Required<Omit<AuthEnv, "AUTH_ORIGIN">>, origin)),
    };
  const res = await cached.auth.handler(req);
  const h = new Headers(res.headers);
  h.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
