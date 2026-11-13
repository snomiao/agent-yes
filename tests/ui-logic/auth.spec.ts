// Unit tests for the Worker's sign-in gate (lab/ui/cf/auth.ts) and the owner
// check the debug chat hub relies on. The better-auth handler itself is
// exercised end to end under `wrangler dev` with a local D1; these pin the
// parts that decide whether it runs at all, and who counts as the owner.
import { describe, expect, it } from "vitest";
import {
  AUTH_PATH,
  DRIVE_APPDATA_SCOPE,
  authConfigured,
  authOptions,
  authOrigin,
  handleAuth,
  isOwner,
  providers,
  sessionUser,
} from "../../lab/ui/cf/auth.ts";

const FULL = {
  AUTH_DB: {} as D1Database,
  BETTER_AUTH_SECRET: "s".repeat(32),
  GITHUB_CLIENT_ID: "client-id",
  GITHUB_CLIENT_SECRET: "client-secret",
};
const GOOGLE = { GOOGLE_CLIENT_ID: "g-id", GOOGLE_CLIENT_SECRET: "g-secret" };
const DB = { AUTH_DB: {} as D1Database, BETTER_AUTH_SECRET: "s".repeat(32) };

describe("authOrigin", () => {
  it("serves auth on agent-yes.com only by default", () => {
    expect(authOrigin({}, "agent-yes.com")).toBe("https://agent-yes.com");
    expect(authOrigin({}, "s.agent-yes.com")).toBeNull();
    expect(authOrigin({}, "x1234567.agent-yes.com")).toBeNull();
    expect(authOrigin({}, "lab.agent-yes.com")).toBeNull();
  });

  it("follows AUTH_ORIGIN for local development", () => {
    const env = { AUTH_ORIGIN: "http://localhost:8799" };
    expect(authOrigin(env, "localhost:8799")).toBe("http://localhost:8799");
    expect(authOrigin(env, "agent-yes.com")).toBeNull();
  });
});

describe("providers", () => {
  it("lists a provider only when it has both of its secrets", () => {
    expect(providers({})).toEqual([]);
    expect(providers({ GOOGLE_CLIENT_ID: "x" })).toEqual([]);
    expect(providers({ ...GOOGLE })).toEqual(["google"]);
    expect(providers({ ...FULL })).toEqual(["github"]);
    expect(providers({ ...FULL, ...GOOGLE })).toEqual(["google", "github"]);
  });
});

describe("authConfigured / handleAuth / sessionUser", () => {
  it("needs the database, the auth secret and at least one provider", () => {
    expect(authConfigured(FULL)).toBe(true);
    expect(authConfigured({ ...DB, ...GOOGLE })).toBe(true);
    expect(authConfigured(DB)).toBe(false);
    expect(authConfigured({ ...FULL, AUTH_DB: undefined })).toBe(false);
    expect(authConfigured({ ...FULL, BETTER_AUTH_SECRET: undefined })).toBe(false);
    expect(authConfigured({ ...FULL, GITHUB_CLIENT_SECRET: undefined })).toBe(false);
  });

  it("answers 503 when sign-in is not configured, so the console offers none", async () => {
    const res = await handleAuth(
      new Request(`https://agent-yes.com${AUTH_PATH}/providers`),
      { GITHUB_CLIENT_ID: "only-this" },
      "https://agent-yes.com",
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("tells the console which providers exist, without touching better-auth", async () => {
    const res = await handleAuth(
      new Request(`https://agent-yes.com${AUTH_PATH}/providers`),
      { ...FULL, ...GOOGLE },
      "https://agent-yes.com",
    );
    expect(await res.json()).toEqual({ providers: ["google", "github"] });
  });

  it("has no session user when sign-in is not configured", async () => {
    const req = new Request("https://agent-yes.com/_ay/chat", { headers: { cookie: "x=1" } });
    expect(await sessionUser(req, {}, "https://agent-yes.com")).toBeNull();
  });
});

describe("authOptions", () => {
  it("enables only the configured providers on the auth path, and encrypts stored tokens", () => {
    const o = authOptions({ ...FULL, ...GOOGLE }, "https://agent-yes.com");
    expect(o.basePath).toBe(AUTH_PATH);
    expect(o.trustedOrigins).toEqual(["https://agent-yes.com"]);
    expect(Object.keys(o.socialProviders)).toEqual(["google", "github"]);
    expect(o.account.encryptOAuthTokens).toBe(true);
    expect(o.telemetry.enabled).toBe(false);
    expect(Object.keys(authOptions(FULL, "https://x").socialProviders)).toEqual(["github"]);
  });

  it("asks Google for the Drive app folder with a refresh token", () => {
    const g = authOptions({ ...DB, ...GOOGLE }, "https://agent-yes.com").socialProviders.google as {
      scope: string[];
      accessType: string;
    };
    expect(g.scope).toEqual([DRIVE_APPDATA_SCOPE]);
    expect(g.accessType).toBe("offline");
  });
});

describe("isOwner", () => {
  it("admits only the owner's email, verified", () => {
    expect(isOwner({ email: "snomiao@gmail.com", emailVerified: true })).toBe(true);
    expect(isOwner({ email: "SNOMIAO@gmail.com", emailVerified: true })).toBe(true);
    expect(isOwner({ email: "snomiao@gmail.com", emailVerified: false })).toBe(false);
    expect(isOwner({ email: "alice@example.com", emailVerified: true })).toBe(false);
    expect(isOwner({ email: null, emailVerified: true })).toBe(false);
  });
});
