// `ay expose <port>` — share a local HTTP/WS server through the agent-yes edge
// relay: https://<id>.agent-yes.com/* ⇄ Exposure DO ⇄ this daemon ⇄ 127.0.0.1:<port>.
//
// The daemon dials OUT (wss://<relay>/_ay/tunnel/<id>), so it works behind any
// NAT, and runs the codehost tunnel protocol's host half against the local
// port. Private by default: visitors need a single-use claim link (it swaps
// for an 8h HttpOnly cookie at the edge; unauthenticated requests never reach
// this machine). See lab/ui/cf/exposure.ts for the edge.
//
// Two front doors share one implementation:
//   - the CLI (`cmdExpose`), which starts one exposure and blocks; and
//   - the in-process manager (`ensureExposure` / `listExposures` /
//     `stopExposure`), which `ay serve` drives from POST /api/expose so the web
//     console can expose a clicked localhost port and revoke it later.

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

/** Live handle for one exposed port. */
export interface ExposureHandle {
  /** Opaque exposure id (also the subdomain label). */
  id: string;
  /** Local loopback port being shared. */
  port: number;
  /** Public host, e.g. x….agent-yes.com (or the relay host for a dev relay). */
  publicHost: string;
  /** Public root URL. */
  url: string;
  /** Relay host this exposure is registered on. */
  relayHost: string;
  createdAt: number;
  /** Mint a fresh single-use claim link and register it with the relay. The
   *  visitor opening it gets an 8h session cookie for this exposure. */
  mintClaim(): string;
  /** Stop sharing (closes the relay socket; the URL then answers 502). */
  stop(): void;
}

/** Serializable view of an active exposure (for the console's ports manager). */
export interface ExposureInfo {
  id: string;
  port: number;
  url: string;
  createdAt: number;
}

function exposuresPath(): string {
  const home = process.env.AGENT_YES_HOME ?? path.join(homedir(), ".agent-yes");
  mkdirSync(home, { recursive: true });
  return path.join(home, "exposures.json");
}

/** Stable id+key per (relay, port): re-exposing a port keeps its URL. */
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

/**
 * Start (or fail) one exposure. Resolves once the relay has accepted the daemon
 * and the tunnel is live; rejects if the relay refuses this exposure (bad key).
 * Reconnects with backoff for the life of the handle.
 */
export function startExposure(opts: {
  port: number;
  relay?: string;
  /** Log lifecycle transitions (CLI wants this; the manager stays quiet). */
  log?: (msg: string) => void;
}): Promise<ExposureHandle> {
  const relay = opts.relay ?? DEFAULT_RELAY;
  const port = opts.port;
  const log = opts.log ?? (() => {});
  const relayUrl = new URL(relay);
  const rec = loadOrCreateExposure(relayUrl.host, port);
  const wsProto = relayUrl.protocol === "http:" ? "ws:" : "wss:";
  const tunnelUrl = `${wsProto}//${relayUrl.host}/_ay/tunnel/${rec.id}`;
  // Public hostname: <id>.<zone> on the real relay; the relay host itself (with
  // a Host-header spoof) when pointing at a dev relay (wrangler dev).
  const publicHost = relayUrl.host === "agent-yes.com" ? `${rec.id}.agent-yes.com` : relayUrl.host;
  const publicUrl = `https://${publicHost}/`;

  let stopped = false;
  let sock: WebSocket | null = null;
  let ready = false;
  let backoff = RECONNECT_MIN_MS;

  const handle: ExposureHandle = {
    id: rec.id,
    port,
    publicHost,
    url: publicUrl,
    relayHost: relayUrl.host,
    createdAt: Date.now(),
    mintClaim() {
      const token = randomBytes(18).toString("base64url");
      const hash = createHash("sha256").update(token).digest("hex");
      if (sock && sock.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify({ t: "claim", claims: [hash] }));
      }
      return `https://${publicHost}/_ay/claim?t=${token}`;
    },
    stop() {
      stopped = true;
      try {
        sock?.close();
      } catch {
        /* ignore */
      }
    },
  };

  return new Promise<ExposureHandle>((resolve, reject) => {
    const connect = () => {
      if (stopped) return;
      sock = new WebSocket(tunnelUrl);
      sock.binaryType = "arraybuffer";
      const ws = sock;
      let ping: ReturnType<typeof setInterval> | null = null;

      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ t: "hello", key: rec.key, port, v: 1 }));
      });
      ws.addEventListener("message", (ev) => {
        if (typeof ev.data !== "string") return; // binary frames belong to the TunnelHost
        let msg: { t?: string };
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.t === "ready") {
          backoff = RECONNECT_MIN_MS;
          new TunnelHost(wsTransport(ws), { port });
          ping = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send("ping");
          }, PING_MS);
          if (!ready) {
            ready = true;
            log(`sharing 127.0.0.1:${port} at ${publicUrl}`);
            resolve(handle);
          } else {
            log(`reconnected`);
          }
        }
      });
      ws.addEventListener("close", (ev) => {
        if (ping) clearInterval(ping);
        if (stopped) return;
        if (ev.code === 1008) {
          const err = new Error(`relay refused exposure (${ev.reason || "forbidden"})`);
          if (!ready) return reject(err);
          log(err.message);
          return;
        }
        log(`connection lost, retrying in ${Math.round(backoff / 1000)}s…`);
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
      });
      ws.addEventListener("error", () => {
        /* close fires right after; retry there */
      });
    };
    connect();
  });
}

// ---- in-process manager (driven by `ay serve` POST /api/expose) ----

const active = new Map<number, ExposureHandle>();
/** In-flight starts, so concurrent POSTs for the same port share one dial. */
const starting = new Map<number, Promise<ExposureHandle>>();

/** Start an exposure for `port` (or reuse a running one). Idempotent per port. */
export async function ensureExposure(port: number, relay?: string): Promise<ExposureHandle> {
  const existing = active.get(port);
  if (existing) return existing;
  const inflight = starting.get(port);
  if (inflight) return inflight;
  const p = startExposure({ port, relay })
    .then((h) => {
      active.set(port, h);
      starting.delete(port);
      return h;
    })
    .catch((e) => {
      starting.delete(port);
      throw e;
    });
  starting.set(port, p);
  return p;
}

export function listExposures(): ExposureInfo[] {
  return [...active.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((h) => ({ id: h.id, port: h.port, url: h.url, createdAt: h.createdAt }));
}

export function stopExposure(port: number): boolean {
  const h = active.get(port);
  if (!h) return false;
  h.stop();
  active.delete(port);
  return true;
}

export function stopAllExposures(): void {
  for (const port of [...active.keys()]) stopExposure(port);
}

// ---- CLI ----

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

  let handle: ExposureHandle;
  try {
    handle = await startExposure({ port, relay, log: (m) => console.log(`[ay expose] ${m}`) });
  } catch (e) {
    console.error(`[ay expose] ${(e as Error).message} — giving up`);
    return 1;
  }
  const claimUrl = handle.mintClaim();
  console.log(`  url:    ${handle.url}`);
  console.log(`  claim:  ${claimUrl}`);
  console.log(`          (one-time link — opens access for 8h in that browser)`);

  const shutdown = () => {
    console.log("\n[ay expose] stopped — the URL now answers 502 until you expose again");
    handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return new Promise<number>(() => {}); // runs until signal
}
