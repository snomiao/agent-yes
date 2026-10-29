// Sign-in for agent-yes.com: GitHub via better-auth, on D1.
//
// Mounted at /_ay/auth/* on the apex (agent-yes.com) only, so its cookies never
// reach the signaling or exposure hosts and its routes can't clash with
// `ay serve`'s /api/*. For now its one consumer is the console's debug mode
// (liagent.ts): the site owner signs in, and only then may a chat box with an
// agent on the other end be mounted on their pages.
//
// Everything is opt-in: without the D1 binding and all three secrets the auth
// routes answer 503 and the console shows no sign-in.
//   wrangler d1 migrations apply agent-yes-auth --remote
//   wrangler secret put BETTER_AUTH_SECRET       (openssl rand -base64 32)
//   wrangler secret put GITHUB_CLIENT_ID
//   wrangler secret put GITHUB_CLIENT_SECRET
// The GitHub OAuth app's callback URL is <AUTH_ORIGIN>/_ay/auth/callback/github.

import { betterAuth } from "better-auth";

export const AUTH_PATH = "/_ay/auth";
export const DEFAULT_AUTH_ORIGIN = "https://agent-yes.com";
/** The site owner: the only account debug mode (and its chat hub) admits. */
export const OWNER_EMAIL = "snomiao@gmail.com";

export interface AuthEnv {
  AUTH_DB?: D1Database;
  BETTER_AUTH_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Override for local `wrangler dev` (e.g. http://localhost:8799). */
  AUTH_ORIGIN?: string;
}

type FullAuthEnv = Required<Omit<AuthEnv, "AUTH_ORIGIN">>;

/** The origin auth is served on, or null when this request's host is not it. */
export function authOrigin(env: AuthEnv, host: string): string | null {
  const origin = env.AUTH_ORIGIN || DEFAULT_AUTH_ORIGIN;
  return new URL(origin).host === host ? origin : null;
}

export const authConfigured = (env: AuthEnv): env is AuthEnv & FullAuthEnv =>
  !!(env.AUTH_DB && env.BETTER_AUTH_SECRET && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);

export function authOptions(env: FullAuthEnv, origin: string) {
  return {
    baseURL: origin,
    basePath: AUTH_PATH,
    secret: env.BETTER_AUTH_SECRET,
    database: env.AUTH_DB,
    trustedOrigins: [origin],
    socialProviders: {
      // better-auth reads the account's primary email from /user/emails (the
      // user:email scope), with GitHub's own verified flag.
      github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
    },
    account: { encryptOAuthTokens: true },
    telemetry: { enabled: false },
  };
}

// One instance per isolate: building it parses the config and sets up the
// adapter, which is wasted work on every request.
let cached: { env: AuthEnv; origin: string; auth: ReturnType<typeof betterAuth> } | null = null;

function getAuth(env: AuthEnv & FullAuthEnv, origin: string) {
  if (!cached || cached.env !== env || cached.origin !== origin)
    cached = { env, origin, auth: betterAuth(authOptions(env, origin)) };
  return cached.auth;
}

/** Handle a request under AUTH_PATH. */
export async function handleAuth(req: Request, env: AuthEnv, origin: string): Promise<Response> {
  if (!authConfigured(env))
    return Response.json({ error: "sign-in is not configured" }, { status: 503 });
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
