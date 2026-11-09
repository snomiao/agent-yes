// The profile menu's gate (lab/ui/profile.js): it must show NOTHING unless the
// site really offers sign-in, so self-hosted domains, the local `ay serve`
// console and deployments without secrets look exactly as before.
import { describe, expect, it } from "vitest";
import { loadAuthState, profileView } from "../../lab/ui/profile.js";

const json = (body: unknown, status = 200, type = "application/json") =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": type } });

const site = (routes: Record<string, () => Response>) => async (url: string) => {
  const r = routes[new URL(url, "https://x.test").pathname.replace("/_ay/auth", "")];
  if (!r)
    return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  return r();
};

describe("loadAuthState", () => {
  it("is unavailable where the site has no auth route (self-hosted, ay serve)", async () => {
    expect(await loadAuthState(site({}) as typeof fetch)).toMatchObject({ available: false });
  });

  it("is unavailable when sign-in is not configured (503)", async () => {
    const f = site({ "/providers": () => json({ error: "off" }, 503) });
    expect(await loadAuthState(f as typeof fetch)).toMatchObject({ available: false });
  });

  it("is unavailable when the route serves HTML (an SPA fallback), not JSON", async () => {
    const f = site({
      "/providers": () => new Response("<html>", { headers: { "content-type": "text/html" } }),
    });
    expect(await loadAuthState(f as typeof fetch)).toMatchObject({ available: false });
  });

  it("is unavailable with no usable provider, and when the network fails", async () => {
    expect(
      await loadAuthState(site({ "/providers": () => json({ providers: [] }) }) as typeof fetch),
    ).toMatchObject({ available: false });
    expect(
      await loadAuthState(
        site({ "/providers": () => json({ providers: ["myspace"] }) }) as typeof fetch,
      ),
    ).toMatchObject({ available: false });
    expect(
      await loadAuthState((async () => {
        throw new Error("offline");
      }) as typeof fetch),
    ).toMatchObject({ available: false });
  });

  it("offers the listed providers, signed out", async () => {
    const f = site({
      "/providers": () => json({ providers: ["google", "github"] }),
      "/get-session": () => json(null),
    });
    expect(await loadAuthState(f as typeof fetch)).toEqual({
      available: true,
      providers: ["google", "github"],
      user: null,
    });
  });

  it("returns the signed-in user", async () => {
    const f = site({
      "/providers": () => json({ providers: ["google"] }),
      "/get-session": () =>
        json({ user: { name: "Alice", email: "alice@example.com", image: null } }),
    });
    const s = await loadAuthState(f as typeof fetch);
    expect(s.user).toEqual({ name: "Alice", email: "alice@example.com", image: "" });
  });
});

describe("profileView", () => {
  it("shows nothing when sign-in is unavailable", () => {
    expect(profileView({ available: false, providers: [], user: null })).toBeNull();
    expect(profileView(null)).toBeNull();
  });

  it("offers one button per provider when signed out", () => {
    const v = profileView({ available: true, providers: ["google", "github"], user: null });
    expect(v?.kind).toBe("signed-out");
    expect(v?.signIn?.map((p: { label: string }) => p.label)).toEqual([
      "Sign in with Google",
      "Sign in with GitHub",
    ]);
  });

  it("shows name and email when signed in, falling back to the email", () => {
    const user = { name: "Alice", email: "alice@example.com", image: "" };
    expect(profileView({ available: true, providers: ["google"], user })).toMatchObject({
      kind: "signed-in",
      name: "Alice",
      email: "alice@example.com",
      initial: "A",
    });
    expect(
      profileView({ available: true, providers: ["google"], user: { ...user, name: "" } }),
    ).toMatchObject({ label: "alice@example.com", initial: "A" });
  });
});
