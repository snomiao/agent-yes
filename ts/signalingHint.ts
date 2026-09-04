/**
 * Why a WebRTC signaling connection failed, said in a way the operator can act
 * on — without pretending to know more than was measured.
 *
 * The report this exists for: `ay ls <alias>` inside a coding-agent sandbox
 * printed only
 *
 *   WebSocket connection to wss://s.agent-yes.com/rc19085 failed: Failed to connect
 *
 * while the identical command succeeded immediately with escalated sandbox
 * permission (29 agents returned). Alias, token and server were all healthy, so
 * every fact in that message was true and none of them pointed at the cause.
 *
 * The temptation is to append "you may be sandboxed" to the failure. That would
 * misdiagnose every genuine outage, and an error that cries wolf is one people
 * learn to skip. So the hint is DERIVED instead: on failure, probe plain HTTPS
 * to the same host. The two outcomes are different problems with different
 * fixes, and the probe distinguishes them:
 *
 *   HTTPS reachable, WSS not  -> something permits ordinary HTTPS and refuses a
 *                                WebSocket upgrade. A sandbox or an intercepting
 *                                proxy does this; an outage does not.
 *   neither reachable         -> no egress at all, or the host really is down.
 *                                Both are named; neither is asserted.
 */

/** What a probe of the signaling host over plain HTTPS established. */
export type HostProbe =
  /** The host answered — anything at all, including an error status. */
  | "https-ok"
  /** HTTPS did not get through either. */
  | "https-failed"
  /** The probe could not be run (no fetch, no time). Nothing is claimed from it. */
  | "unknown";

/**
 * Reach the signaling host over ordinary HTTPS. ANY HTTP response counts as
 * reachable — a 404 or a 400 still proves egress, TLS and DNS all worked, which
 * is the whole question. Never throws; a failure IS the answer.
 */
export async function probeSignalingHost(
  host: string,
  timeoutMs = 4000,
  // Injected so the outcome mapping is testable without a network, and so a
  // test can never depend on the real host being up.
  doFetch: typeof fetch = fetch,
): Promise<HostProbe> {
  try {
    await doFetch(`https://${host}/`, {
      method: "HEAD",
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    return "https-ok";
  } catch {
    return "https-failed";
  }
}

/**
 * The operator-facing explanation, given the original error and what the probe
 * found. Pure, so the wording is testable without a network.
 *
 * Every branch keeps the original error text: it is the only part that is
 * certainly true, and a hint that replaces evidence is worse than no hint.
 */
export function signalingFailureHint(cause: string, probe: HostProbe, host: string): string {
  const head = `cannot reach the signaling host ${host}: ${cause}`;
  switch (probe) {
    case "https-ok":
      return (
        `${head}\n` +
        `  HTTPS to ${host} works from here, so DNS, TLS and egress are fine and the\n` +
        `  server is up — only the WebSocket did not connect. Something in between is\n` +
        `  allowing HTTPS and refusing the upgrade, which is what a coding-agent\n` +
        `  sandbox or an intercepting proxy does.\n` +
        `  If you are running inside a sandbox (Codex and similar): re-run with\n` +
        `  escalated / external-network permission. If you are behind a corporate\n` +
        `  proxy: it must allow WebSocket upgrades to ${host}.`
      );
    case "https-failed":
      return (
        `${head}\n` +
        `  HTTPS to ${host} does not work from here either, so this is not specific to\n` +
        `  WebSockets — either this environment has no outbound network, or the host\n` +
        `  is genuinely unreachable.\n` +
        `  If you are running inside a sandbox (Codex and similar): re-run with\n` +
        `  escalated / external-network permission. Otherwise check connectivity and\n` +
        `  whether ${host} is up.`
      );
    default:
      return (
        `${head}\n` +
        `  If you are running inside a coding-agent sandbox, outbound WebSockets are\n` +
        `  often blocked — re-run with escalated / external-network permission.`
      );
  }
}
