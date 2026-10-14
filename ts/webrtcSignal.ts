/**
 * The CLI viewer's signaling decisions, as pure functions.
 *
 * Every way a WebRTC join can fail used to surface as one thing: a 25 s
 * "connect timeout", followed by a hint that blamed a sandbox. The server
 * actually tells the viewer which it is — `welcome.hostPresent:false` when no
 * host is attached, a 1008 close with a reason when the join is rejected — and
 * the handshake itself has observable phases (socket open, offer received,
 * channel confirmed). Keeping that bookkeeping here, away from the socket and
 * peer-connection plumbing in webrtcRemote.ts, makes each branch testable
 * without a network, and keeps the sandbox hint for the one case it is true.
 */

/** Where the join was when it failed; drives the operator-facing explanation. */
export type ConnectPhase =
  /** The signaling WebSocket never opened. The only phase a sandbox explains. */
  | "ws-not-open"
  /** The socket opened but no host is attached to the room / none offered. */
  | "no-host"
  /** The signaling server rejected the join (wrong secret, room not open…). */
  | "rejected"
  /** Signaling worked and the host offered, but no data channel came up. */
  | "ice-timeout";

export class ConnectError extends Error {
  constructor(
    readonly phase: ConnectPhase,
    message: string,
  ) {
    super(message);
    this.name = "ConnectError";
  }
}

/** The viewer's progress through the join, updated by the caller. */
export interface SignalState {
  opened: boolean;
  offered: boolean;
  confirmed: boolean;
}

export type SignalAction =
  | { kind: "ignore" }
  | { kind: "fail"; error: ConnectError }
  /** The first offer: build the peer connection and answer it. */
  | { kind: "offer"; sdp: string; iceServers: any[]; from?: string }
  /** A second offer — two hosts in one room. Answering both breaks the handshake. */
  | { kind: "duplicate-offer" }
  /** A host candidate: `queue` when it arrived before the offer (the Rust host
   *  may trickle candidates first), else apply it. */
  | { kind: "candidate"; candidate: any; queue: boolean };

/** Classify one signaling frame against the current state. */
export function reduceSignal(state: SignalState, m: any): SignalAction {
  if (!m || typeof m !== "object") return { kind: "ignore" };
  switch (m.type) {
    case "welcome":
      // The browser console fails fast on this; the CLI used to wait out the
      // whole timeout and then blame the network.
      if (m.hostPresent === false)
        return {
          kind: "fail",
          error: new ConnectError("no-host", "the room is open but no host is attached to it"),
        };
      return { kind: "ignore" };
    case "offer":
      if (state.offered) return { kind: "duplicate-offer" };
      return { kind: "offer", sdp: m.sdp, iceServers: m.iceServers || [], from: m.from };
    case "candidate":
      return { kind: "candidate", candidate: m.candidate, queue: !state.offered };
    default:
      return { kind: "ignore" };
  }
}

/** The error for a socket that closed before the channel was confirmed. */
export function closeError(state: SignalState, code: number, reason: string): ConnectError {
  const why = `signaling closed (code ${code}${reason ? `: ${reason}` : ""})`;
  if (!state.opened) return new ConnectError("ws-not-open", `${why} before the socket opened`);
  // 1008 is the server's policy-violation close: bad secret, room not open.
  // Any close that carries a reason is the server explaining itself.
  if (code === 1008 || reason) return new ConnectError("rejected", why);
  if (!state.offered) return new ConnectError("no-host", `${why} before the host offered`);
  return new ConnectError("ice-timeout", `${why} during the WebRTC handshake`);
}

/** The error for the connect deadline expiring. */
export function timeoutError(state: SignalState, timeoutMs: number): ConnectError {
  const s = `${Math.round(timeoutMs / 1000)}s`;
  if (!state.opened) return new ConnectError("ws-not-open", `signaling did not open within ${s}`);
  if (!state.offered) return new ConnectError("no-host", `no host answered the join within ${s}`);
  return new ConnectError("ice-timeout", `no WebRTC data channel came up within ${s}`);
}

/** The error for a WebSocket `error` event. */
export function socketError(state: SignalState, detail: string): ConnectError {
  return state.opened
    ? new ConnectError("rejected", `signaling error after connect: ${detail}`)
    : new ConnectError("ws-not-open", `signaling error: ${detail}`);
}

/**
 * The operator-facing explanation. `sandboxHint` is the HTTPS-probe-derived
 * note from signalingHint.ts and is consulted ONLY for a socket that never
 * opened: every later phase proves the WebSocket upgrade worked, so blaming a
 * sandbox or proxy there would be wrong — and sent one reader down exactly
 * that path.
 */
export function describeConnectFailure(
  err: Error,
  host: string,
  sandboxHint: (cause: string) => Promise<string>,
): Promise<string> {
  const phase = err instanceof ConnectError ? err.phase : "ws-not-open";
  const cause = err.message;
  switch (phase) {
    case "no-host":
      return Promise.resolve(
        `no host in the room at ${host}: ${cause}\n` +
          `  The signaling server is reachable and accepted the join — the daemon on the\n` +
          `  other machine is not attached to this room. There, run \`ay share status\`:\n` +
          `  if it prints a different link, the room rotated (or the daemon was\n` +
          `  reinstalled) and this saved remote is stale — re-add it with the new link.`,
      );
    case "rejected":
      return Promise.resolve(
        `join rejected by the signaling host ${host}: ${cause}\n` +
          `  The room id or secret in this saved remote no longer matches what the host\n` +
          `  serves (it rotated, or the link was copied from a different machine).\n` +
          `  On the host run \`ay share status\` and re-add the remote with that link.`,
      );
    case "ice-timeout":
      return Promise.resolve(
        `WebRTC handshake with the host behind ${host} failed: ${cause}\n` +
          `  Signaling worked and the host answered, so this is not a sandbox or proxy\n` +
          `  problem — the two machines could not open a data channel. Usual causes: a\n` +
          `  second host answering in the same room (on the host: \`ay serve status\`,\n` +
          `  and kill any stray \`ayrs serve\`), or ICE blocked between the networks.`,
      );
    default:
      return sandboxHint(cause);
  }
}
