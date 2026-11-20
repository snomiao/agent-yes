import { describe, expect, it } from "bun:test";
import worker, { type Env } from "../../lab/ui/cf/worker";

describe("canonical account host", () => {
  const env = {
    ASSETS: { fetch: async () => new Response("console") },
  } as unknown as Env;

  for (const path of [
    "/w/?view=agents",
    "/auth/?returnTo=%2Fw%2F",
    "/api/auth/get-session",
    "//example.invalid/w/",
  ]) {
    it(`redirects www ${path} to the canonical origin`, async () => {
      const response = await worker.fetch(new Request(`https://www.agent-yes.com${path}`), env);
      expect(response.status).toBe(308);
      expect(response.headers.get("Location")).toBe(`https://agent-yes.com${path}`);
    });
  }

  it("preserves POST semantics when redirecting", async () => {
    const response = await worker.fetch(
      new Request("https://www.agent-yes.com/api/auth/sign-in/social", {
        method: "POST",
        body: "{}",
      }),
      env,
    );
    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe("https://agent-yes.com/api/auth/sign-in/social");
  });

  it("does not redirect the canonical console", async () => {
    const response = await worker.fetch(new Request("https://agent-yes.com/w/"), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("console");
  });

  it("does not redirect unrelated subdomains into the trusted auth origin", async () => {
    const response = await worker.fetch(
      new Request("https://s.agent-yes.com/api/auth/get-session"),
      env,
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("Location")).toBeNull();
  });
});
