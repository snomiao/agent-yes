import { afterEach, describe, expect, it } from "bun:test";
import { signal } from "../../lab/ui/cf/device-signal";
import { Database } from "bun:sqlite";
import { betterAuth } from "better-auth";
import { serializeSignedCookie } from "better-call";
import { getMigrations } from "better-auth/db/migration";
import { authFetch, authOptions, authOrigin, type AuthEnv } from "../../lab/ui/cf/auth";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** Exercise Better Auth's native D1 dialect against SQLite without network I/O. */
async function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(
    await Bun.file(
      new URL("../../lab/ui/cf/migrations/0001_better_auth.sql", import.meta.url),
    ).text(),
  );
  const prepare = (query: string, values: unknown[] = []) => ({
    bind: (...bound: unknown[]) => prepare(query, bound),
    async all() {
      const results = db.prepare(query).all(...(values as any[]));
      const meta = db
        .query("SELECT changes() AS changes, last_insert_rowid() AS last_row_id")
        .get();
      return { results, meta };
    },
  });
  const env: AuthEnv = {
    AUTH_DB: {
      prepare: prepare as never,
      batch: (async (statements: ReturnType<typeof prepare>[]) =>
        Promise.all(statements.map((s) => s.all()))) as never,
      exec: async (query) => db.exec(query),
    },
    BETTER_AUTH_SECRET: "synthetic-auth-test-secret-0000000000000000",
    GOOGLE_CLIENT_ID: "synthetic-google-client",
    GOOGLE_CLIENT_SECRET: "synthetic-google-secret",
  };
  return { db, env };
}

const request = (path: string, body?: unknown, origin = "https://agent-yes.com") =>
  new Request(
    `${origin}/api/auth/${path}`,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: origin,
            "CF-Connecting-IP": "192.0.2.1",
          },
          body: JSON.stringify(body),
        },
  );

describe("Google auth backend", () => {
  it("pins the production origin and only permits explicit local preview origins", () => {
    expect(authOrigin({})).toBe("https://agent-yes.com");
    expect(authOrigin({ BETTER_AUTH_URL: "http://localhost:8787" })).toBe("http://localhost:8787");
    for (const url of [
      "https://evil.example",
      "https://s.agent-yes.com",
      "https://agent-yes.com/auth",
      "https://user:password@agent-yes.com",
    ])
      expect(() => authOrigin({ BETTER_AUTH_URL: url })).toThrow();
  });

  it("uses a migration matching the installed Better Auth schema", async () => {
    const { db, env } = await fixture();
    const options = authOptions(env);
    options.database = db;
    const migration = await getMigrations(options);
    expect(migration.toBeCreated).toEqual([]);
    expect(migration.toBeAdded).toEqual([]);
    expect(migration.toBeAddedIndexes).toEqual([]);
    expect(migration.schemaProblems).toEqual([]);
  });

  it("returns no session for an anonymous or forged-cookie request", async () => {
    const { env } = await fixture();
    for (const cookie of ["", "__Host-agent-yes.session_token=forged.signature"]) {
      const req = request("get-session");
      if (cookie) req.headers.set("Cookie", cookie);
      const response = await authFetch(req, env);
      expect(response.status).toBe(200);
      expect(await response.json()).toBeNull();
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("starts Google OAuth with a pinned callback and a host-only secure state cookie", async () => {
    const { env, db } = await fixture();
    const response = await authFetch(
      request("sign-in/social", { provider: "google", callbackURL: "/w/" }),
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string };
    const destination = new URL(body.url);
    expect(destination.origin).toBe("https://accounts.google.com");
    expect(destination.searchParams.get("redirect_uri")).toBe(
      "https://agent-yes.com/api/auth/callback/google",
    );
    expect(destination.searchParams.get("state")).toBeTruthy();
    const cookies = response.headers.get("Set-Cookie") || "";
    expect(cookies).toContain("HttpOnly");
    expect(cookies).toContain("Secure");
    expect(cookies).toMatch(/^__Host-agent-yes\./);
    expect(cookies).not.toMatch(/\bDomain=/i);
    expect(db.query("SELECT count(*) AS total FROM auth_verification").get()).toEqual({ total: 1 });
  });

  it("pairs only same-origin sessions and chooses the room from the verified account", async () => {
    const { env } = await fixture();
    const ctx = await betterAuth(authOptions(env)).$context;
    const rooms: string[] = [];
    const bindings = { ...env, DEVICE_SIGNAL: {
      idFromName: (id: string) => id,
      get: (id: string) => ({ fetch: () => { rooms.push(id); return new Response("paired"); } }),
    } } as unknown as Parameters<typeof signal>[1];
    const pair = (cookie = "", origin = "https://agent-yes.com") => signal(new Request(
      "https://agent-yes.com/api/device-pair?account=other", {headers:{Origin:origin, Upgrade:"websocket", Cookie:cookie}}),bindings);
    expect((await pair()).status).toBe(401);
    for (const label of ["first","second"]) {
      const user = await ctx.internalAdapter.createUser({name:label, email:label+"@example.com", emailVerified:true},
        {method:"oauth",oauth:{providerId:"google"}});
      const session = await ctx.internalAdapter.createSession(user.id);
      const cookie = (await serializeSignedCookie(ctx.authCookies.sessionToken.name,session.token,env.BETTER_AUTH_SECRET!)).split(";")[0]!;
      expect((await pair(cookie,"https://other.example")).status).toBe(403);
      expect((await pair(cookie)).status).toBe(200);
      expect(rooms.at(-1)).toBe(user.id);
    }
    expect(new Set(rooms).size).toBe(2);
  });

  it("reads a signed persistent session and revokes it on sign-out", async () => {
    const { env, db } = await fixture();
    const auth = betterAuth(authOptions(env));
    const context = await auth.$context;
    const user = await context.internalAdapter.createUser(
      { name: "Example User", email: "user@example.com", emailVerified: true },
      { method: "oauth", oauth: { providerId: "google" } },
    );
    const session = await context.internalAdapter.createSession(user.id);
    expect(context.authCookies.sessionToken.name).toBe("__Host-agent-yes.session_token");
    const cookie = (
      await serializeSignedCookie(
        context.authCookies.sessionToken.name,
        session.token,
        env.BETTER_AUTH_SECRET!,
      )
    ).split(";")[0]!;
    const signed = request("get-session");
    signed.headers.set("Cookie", cookie);
    const response = await authFetch(signed, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      user: { name: "Example User", email: "user@example.com" },
    });
    const logout = request("sign-out", {});
    logout.headers.set("Cookie", cookie);
    expect((await authFetch(logout, env)).status).toBe(200);
    expect(db.query("SELECT count(*) AS total FROM auth_session").get()).toEqual({ total: 0 });
    expect(await (await authFetch(signed, env)).json()).toBeNull();
  });

  it("rejects hostile origins and callback URLs without creating OAuth state", async () => {
    const { env, db } = await fixture();
    const badOrigin = request("sign-in/social", { provider: "google", callbackURL: "/w/" });
    badOrigin.headers.set("Origin", "https://xexample.agent-yes.com");
    expect((await authFetch(badOrigin, env)).status).toBe(403);
    expect(
      (
        await authFetch(
          request("sign-in/social", { provider: "google", callbackURL: "https://evil.example" }),
          env,
        )
      ).status,
    ).toBe(403);
    expect(db.query("SELECT count(*) AS total FROM auth_verification").get()).toEqual({ total: 0 });
  });

  it("returns an invalid OAuth callback to the auth page without calling Google", async () => {
    const { env } = await fixture();
    const response = await authFetch(request("callback/google?error=access_denied"), env);
    expect(response.status).toBe(302);
    const destination = new URL(response.headers.get("Location")!);
    expect(destination.origin).toBe("https://agent-yes.com");
    expect(destination.pathname).toBe("/auth/");
    expect(destination.searchParams.has("error")).toBe(true);
  });

  it("ignores spoofed Host and forwarded headers and fails closed without bindings", async () => {
    const { env } = await fixture();
    const foreign = request("get-session", undefined, "https://s.agent-yes.com");
    foreign.headers.set("Host", "agent-yes.com");
    foreign.headers.set("X-Forwarded-Host", "agent-yes.com");
    expect((await authFetch(foreign, env)).status).toBe(404);
    const missing = await authFetch(request("get-session"), {});
    expect(missing.status).toBe(503);
    expect(await missing.text()).not.toContain("SECRET");
  });
});
