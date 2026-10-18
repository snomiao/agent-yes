// Unit tests for the Worker's optional room-sync auth gate (lab/ui/cf/auth.ts).
// The better-auth handler itself was exercised end to end under `wrangler dev`
// with a local D1; these pin the parts that decide whether it runs at all.
import { describe, expect, it } from "vitest";
import {
  AUTH_PATH,
  DRIVE_APPDATA_SCOPE,
  authConfigured,
  authOptions,
  authOrigin,
  handleAuth,
} from "../../lab/ui/cf/auth.ts";

const FULL = {
  AUTH_DB: {} as D1Database,
  BETTER_AUTH_SECRET: "s".repeat(32),
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
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

describe("authConfigured / handleAuth", () => {
  it("needs the database and all three secrets", () => {
    expect(authConfigured(FULL)).toBe(true);
    for (const k of Object.keys(FULL) as (keyof typeof FULL)[]) {
      const env = { ...FULL, [k]: undefined };
      expect(authConfigured(env)).toBe(false);
    }
  });

  it("answers 503 when sync is not configured, so the console hides it", async () => {
    const res = await handleAuth(
      new Request(`https://agent-yes.com${AUTH_PATH}/get-session`),
      { GOOGLE_CLIENT_ID: "only-this" },
      "https://agent-yes.com",
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("authOptions", () => {
  it("asks Google for the Drive app folder with a refresh token, and encrypts stored tokens", () => {
    const o = authOptions(FULL, "https://agent-yes.com");
    expect(o.basePath).toBe(AUTH_PATH);
    expect(o.trustedOrigins).toEqual(["https://agent-yes.com"]);
    expect(o.socialProviders.google.scope).toEqual([DRIVE_APPDATA_SCOPE]);
    expect(o.socialProviders.google.accessType).toBe("offline");
    expect(o.account.encryptOAuthTokens).toBe(true);
    expect(o.telemetry.enabled).toBe(false);
  });
});
