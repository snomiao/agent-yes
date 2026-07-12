// `ay expose <port>` — share a local HTTP/WS server through the agent-yes edge
// relay: https://<id>.agent-yes.com/* ⇄ Exposure DO ⇄ this daemon ⇄ 127.0.0.1:<port>.
//
// The daemon dials OUT (wss://<relay>/_ay/tunnel/<id>), so it works behind any
// NAT, and runs the codehost tunnel protocol's host half against the local
// port. Private by default: visitors need the single-use claim link printed
// below (it swaps for an 8h HttpOnly cookie at the edge; unauthenticated
// requests never reach this machine). See lab/ui/cf/exposure.ts for the edge.

import { randomBytes, createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { TunnelHost } from "codehost/tunnel";
import type { TunnelTransport } from "codehost/tunnel";

const DEFAULT_RELAY = "https://agent-yes.com";
const PING_MS = 25_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

interface ExposureRecord {
  id: string;
  key: string;
}

function exposuresPath(): string {
  const home = process.env.AGENT_YES_HOME ?? path.join(homedir(), ".agent-yes");
  mkdirSync(home, { recursive: true });
  return path.join(home, "exposures.json");
}

/** Stable id+key per (relay, port): re-running `ay expose 5173` keeps its URL. */
function loadOrCreateExposure(relayHost: string, port: number): ExposureRecord {
  const file = exposuresPath();
  let all: Record<string, ExposureRecord> = {};
  try {
    all = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    /* first run */
  }
  const slot = `${relayHost}:${port}`;
  const existing = all[slot];
  if (existing?.id && existing.key) return existing;
  const rec: ExposureRecord = {
    // "x" prefix: exposure hostnames can never collide with named subdomains.
    id: "x" + randomBytes(8).toString("hex").slice(0, 15),
    key: randomBytes(32).toString("hex"),
  };
  all[slot] = rec;
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n");
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return rec;
}

/** Bun's browser-style WebSocket as a TunnelTransport. No bufferedAmountLow
 *  event exists here — TunnelHost's 100ms safety poll covers drain resume. */
function wsTransport(ws: WebSocket): TunnelTransport {
  return {
    // Copy into a fresh ArrayBuffer-backed view: Bun's ws.send mishandles a
    // subarray view (byteOffset > 0), which the protocol's fragmentation emits.
    send: (frame) => {
      const copy = new Uint8Array(frame.byteLength);
      copy.set(frame);
      ws.send(copy);
    },
    isOpen: () => ws.readyState === WebSocket.OPEN,
    bufferedAmount: () => ws.bufferedAmount,
    onFrame: (cb) => {
      ws.addEventListener("message", (ev) => {
        if (typeof ev.data === "string") return;
        const d = ev.data as ArrayBuffer | Uint8Array;
        cb(d instanceof Uint8Array ? d : new Uint8Array(d));
      });
    },
    onClose: (cb) => ws.addEventListener("close", () => cb()),
  };
}

export async function cmdExpose(args: string[]): Promise<number> {
  let relay = DEFAULT_RELAY;
  let port = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--relay") relay = args[++i] ?? relay;
    else if (a.startsWith("--relay=")) relay = a.slice("--relay=".length);
    else if (/^\d+$/.test(a)) port = Number(a);
    else if (a === "-h" || a === "--help") {
      console.log(
        `Usage: ay expose <port> [--relay ${DEFAULT_RELAY}]\n\n` +
          `Shares http://127.0.0.1:<port> at https://<id>.agent-yes.com (private:\n` +
          `visitors need the printed one-time claim link, which sets an 8h cookie).\n` +
          `The URL is stable per port on this machine. Ctrl-C stops sharing.`,
      );
      return 0;
    }
  }
  if (!port || port < 1 || port > 65535) {
    console.error("usage: ay expose <port> [--relay https://…]  (see ay expose --help)");
    return 1;
  }

  const relayUrl = new URL(relay);
  const rec = loadOrCreateExposure(relayUrl.host, port);
  const wsProto = relayUrl.protocol === "http:" ? "ws:" : "wss:";
  const tunnelUrl = `${wsProto}//${relayUrl.host}/_ay/tunnel/${rec.id}`;
  // Public hostname: <id>.<zone> on the real relay; the relay host itself (with
  // a Host-header spoof) when pointing at wrangler dev.
  const publicHost = relayUrl.host === "agent-yes.com" ? `${rec.id}.agent-yes.com` : relayUrl.host;

  // Fresh single-use claim token every run; only its hash goes to the edge.
  const claimToken = randomBytes(18).toString("base64url");
  const claimHash = createHash("sha256").update(claimToken).digest("hex");

  let stopped = false;
  let ws: WebSocket | null = null;
  let backoff = RECONNECT_MIN_MS;
  let announced = false;

  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(tunnelUrl);
    ws.binaryType = "arraybuffer";
    const sock = ws;
    let ping: ReturnType<typeof setInterval> | null = null;

    sock.addEventListener("open", () => {
      sock.send(JSON.stringify({ t: "hello", key: rec.key, port, claims: [claimHash], v: 1 }));
    });
    sock.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return; // binary frames belong to the TunnelHost
      let msg: { t?: string };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.t === "ready") {
        backoff = RECONNECT_MIN_MS;
        new TunnelHost(wsTransport(sock), { port });
        ping = setInterval(() => {
          if (sock.readyState === WebSocket.OPEN) sock.send("ping");
        }, PING_MS);
        if (!announced) {
          announced = true;
          console.log(`[ay expose] sharing 127.0.0.1:${port}`);
          console.log(`  url:    https://${publicHost}/`);
          console.log(`  claim:  https://${publicHost}/_ay/claim?t=${claimToken}`);
          console.log(`          (one-time link — opens access for 8h in that browser)`);
        } else {
          console.log(`[ay expose] reconnected`);
        }
      }
    });
    sock.addEventListener("close", (ev) => {
      if (ping) clearInterval(ping);
      if (stopped) return;
      if (ev.code === 1008) {
        console.error(`[ay expose] relay refused this exposure (${ev.reason || "forbidden"}) — giving up`);
        process.exit(1);
      }
      console.log(`[ay expose] connection lost, retrying in ${Math.round(backoff / 1000)}s…`);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    });
    sock.addEventListener("error", () => {
      /* close fires right after; retry there */
    });
  };
  connect();

  const shutdown = () => {
    stopped = true;
    console.log("\n[ay expose] stopped — the URL now answers 502 until you expose again");
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return new Promise<number>(() => {}); // runs until signal
}
