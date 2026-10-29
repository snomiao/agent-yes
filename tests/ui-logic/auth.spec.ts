// Unit tests for the Worker's sign-in gate (lab/ui/cf/auth.ts) and the owner
// check the debug chat hub relies on. The better-auth handler itself is
// exercised end to end under `wrangler dev` with a local D1; these pin the
// parts that decide whether it runs at all, and who counts as the owner.
import { describe, expect, it } from "vitest";
import {
  AUTH_PATH,
  authConfigured,
  authOptions,
  authOrigin,
  handleAuth,
  isOwner,
  sessionUser,
} from "../../lab/ui/cf/auth.ts";

const FULL = {
  AUTH_DB: {} as D1Database,
  BETTER_AUTH_SECRET: "s".repeat(32),
  GITHUB_CLIENT_ID: "client-id",
  GITHUB_CLIENT_SECRET: "client-secret",
};

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

describe("authConfigured / handleAuth / sessionUser", () => {
  it("needs the database and all three secrets", () => {
    expect(authConfigured(FULL)).toBe(true);
    for (const k of Object.keys(FULL) as (keyof typeof FULL)[]) {
      expect(authConfigured({ ...FULL, [k]: undefined })).toBe(false);
    }
  });

  it("answers 503 when sign-in is not configured, so the console offers none", async () => {
    const res = await handleAuth(
      new Request(`https://agent-yes.com${AUTH_PATH}/get-session`),
      { GITHUB_CLIENT_ID: "only-this" },
      "https://agent-yes.com",
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("has no session user when sign-in is not configured", async () => {
    const req = new Request("https://agent-yes.com/_ay/chat", { headers: { cookie: "x=1" } });
    expect(await sessionUser(req, {}, "https://agent-yes.com")).toBeNull();
  });
});

describe("authOptions", () => {
  it("signs in with GitHub on the auth path, and encrypts stored tokens", () => {
    const o = authOptions(FULL, "https://agent-yes.com");
    expect(o.basePath).toBe(AUTH_PATH);
    expect(o.trustedOrigins).toEqual(["https://agent-yes.com"]);
    expect(o.socialProviders.github.clientId).toBe("client-id");
    expect(o.account.encryptOAuthTokens).toBe(true);
    expect(o.telemetry.enabled).toBe(false);
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
