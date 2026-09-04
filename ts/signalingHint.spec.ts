import { describe, expect, it } from "vitest";
import { probeSignalingHost, signalingFailureHint } from "./signalingHint.ts";

const CAUSE = "WebSocket connection to 'wss://s.agent-yes.com/rc19085' failed: Failed to connect";
const HOST = "s.agent-yes.com";

describe("signalingFailureHint", () => {
  it("always keeps the original error — the one part known to be true", () => {
    for (const probe of ["https-ok", "https-failed", "unknown"] as const) {
      expect(signalingFailureHint(CAUSE, probe, HOST)).toContain(CAUSE);
      expect(signalingFailureHint(CAUSE, probe, HOST)).toContain(HOST);
    }
  });

  it("blames the local environment ONLY when HTTPS to the same host works", () => {
    // The reported case: alias, token and server were all healthy, and the same
    // command succeeded with escalated sandbox permission. HTTPS reaching the
    // host is what makes "something is refusing the upgrade" a deduction rather
    // than a guess.
    const hint = signalingFailureHint(CAUSE, "https-ok", HOST);
    expect(hint).toMatch(/sandbox/i);
    expect(hint).toMatch(/escalated|external-network/i);
    expect(hint).toMatch(/proxy/i);
    // It must NOT tell the operator to go looking at the server.
    expect(hint).toMatch(/the\s+server is up/i);
  });

  it("does not misdiagnose a genuine outage as a sandbox problem", () => {
    // When HTTPS fails too, a blocked sandbox and a down host are BOTH live
    // possibilities. Naming only the sandbox would send someone chasing their
    // own permissions while the service is actually down.
    const hint = signalingFailureHint(CAUSE, "https-failed", HOST);
    expect(hint).toMatch(/not specific to\s*\n?\s*WebSockets/);
    expect(hint).toMatch(/genuinely unreachable|check connectivity/i);
    expect(hint).toMatch(/sandbox/i); // still offered, as one cause among two
    // And it must not claim the server is fine, which the probe did not show.
    expect(hint).not.toMatch(/the\s+server is up/i);
  });

  it("claims nothing from a probe that could not run", () => {
    const hint = signalingFailureHint(CAUSE, "unknown", HOST);
    expect(hint).toMatch(/sandbox/i);
    expect(hint).not.toMatch(/HTTPS to .* works/);
    expect(hint).not.toMatch(/does not work from here either/);
  });

  it("is a multi-line note, not a wall of text", () => {
    // It prints on every failed remote command; if it reads as noise it gets
    // skipped, which is how a real hint stops working.
    for (const probe of ["https-ok", "https-failed", "unknown"] as const) {
      const [first, ...rest] = signalingFailureHint(CAUSE, probe, HOST).split("\n");
      expect(rest.length + 1).toBeLessThanOrEqual(9);
      // The first line carries the original error verbatim and is as long as
      // that error is; the added guidance is what must stay scannable.
      expect(first).toContain(CAUSE);
      for (const l of rest) expect(l.length).toBeLessThanOrEqual(100);
    }
  });
});

describe("probeSignalingHost", () => {
  it("treats ANY http response as reachable, including an error status", async () => {
    // A 404 still proves DNS, TLS and egress all worked, which is the only
    // question being asked.
    const notFound = async () => new Response("nope", { status: 404 });
    expect(await probeSignalingHost(HOST, 1000, notFound as typeof fetch)).toBe("https-ok");
  });

  it("answers instead of throwing when the host cannot be reached", async () => {
    // A failure here IS the answer — it must never replace the original error
    // with an error from the diagnosis itself.
    const boom = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(probeSignalingHost(HOST, 1000, boom as typeof fetch)).resolves.toBe(
      "https-failed",
    );
  });

  it("does not hang a failing command waiting on the probe", async () => {
    const never = (_u: any, init: any) =>
      new Promise<Response>((_res, rej) =>
        init.signal.addEventListener("abort", () => rej(new Error("aborted"))),
      );
    const t0 = Date.now();
    expect(await probeSignalingHost(HOST, 150, never as unknown as typeof fetch)).toBe(
      "https-failed",
    );
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
