import type { networkInterfaces } from "node:os";

// Pure helpers behind `ay share` (ts/shareCmd.ts, the interactive shell): which
// daemon args a mode needs, LAN/tailscale detection parsing, the exact
// third-party commands the [y/N] prompts show, and the share URL format.

export type ShareMode = "local" | "portless" | "lan" | "tailscale" | "webrtc";
export const SHARE_MODES: ShareMode[] = ["local", "portless", "lan", "tailscale", "webrtc"];
export const DEFAULT_SHARE_PORT = 7432;
export const DEFAULT_TS_PATH = "/ay";

export function flagValue(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === flag) return args[i + 1];
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return undefined;
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.some((a) => a === flag || a.startsWith(`${flag}=`));
}

export function dropFlagWithValue(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === flag) {
      i++;
      continue;
    }
    if (a.startsWith(`${flag}=`)) continue;
    out.push(a);
  }
  return out;
}

/**
 * The daemon args a mode needs, built on top of whatever the daemon already runs
 * with (so sharing over one more way never drops an existing one). `prior` null =
 * no daemon installed. Returns `prior` unchanged when it already fits.
 */
export function planDaemonArgs(
  prior: string[] | null,
  mode: ShareMode,
  defaultPort = DEFAULT_SHARE_PORT,
): string[] {
  let args = [...(prior ?? [])];
  const hasWebrtc = hasFlag(args, "--webrtc") || hasFlag(args, "--share");
  // HTTP is the default mode — on unless the daemon is webrtc-only.
  const hasHttp = hasFlag(args, "--http") || hasFlag(args, "--share") || !hasWebrtc;

  if (mode === "webrtc") {
    if (!hasWebrtc) {
      if (prior !== null && hasHttp && !hasFlag(args, "--http")) args.push("--http");
      args.push("--webrtc");
    }
    return args;
  }
  if (!hasHttp) args.push("--http");
  // Portless owns the port (it assigns the backend and fronts it at
  // https://agent-yes.localhost), so it's exactly the mode WITHOUT --port; every
  // other HTTP mode needs a stable port to point a browser / LAN / tailscale at.
  if (mode === "portless") return dropFlagWithValue(args, "--port");
  if (flagValue(args, "--port") === undefined) args.push("--port", String(defaultPort));
  if (mode === "lan" && flagValue(args, "--host") !== "0.0.0.0") {
    args = dropFlagWithValue(args, "--host");
    args.push("--host", "0.0.0.0");
  }
  return args;
}

type Ifaces = ReturnType<typeof networkInterfaces>;

/** First private-range IPv4 (not loopback, not Tailscale's 100.64/10 CGNAT). */
export function pickLanIp(ifaces: Ifaces): string | null {
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const [x, y] = a.address.split(".").map(Number) as [number, number];
      const priv = x === 10 || (x === 192 && y === 168) || (x === 172 && y >= 16 && y <= 31);
      if (priv) return a.address;
    }
  }
  return null;
}

/** MagicDNS name of this node from `tailscale status --json`, or null when not up. */
export function tailscaleDnsName(status: any): string | null {
  if (!status || status.BackendState !== "Running") return null;
  const dns = String(status.Self?.DNSName ?? "").replace(/\.$/, "");
  return dns || null;
}

export type TsRoute =
  | { status: "ok" }
  | { status: "missing" }
  | { status: "conflict"; proxy: string };

/**
 * Is `https://<dns>/<mount>` already proxied to our loopback port? Tailscale
 * strips the mount before forwarding, so the target must be the port's root.
 */
export function findTailscaleRoute(
  serveStatus: any,
  dns: string,
  mount: string,
  port: number,
): TsRoute {
  const handlers = serveStatus?.Web?.[`${dns}:443`]?.Handlers ?? {};
  const want = mount.replace(/\/+$/, "");
  for (const [p, h] of Object.entries<any>(handlers)) {
    if (p.replace(/\/+$/, "") !== want) continue;
    const proxy = String(h?.Proxy ?? "");
    const m = /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)(\/.*)?$/.exec(proxy);
    if (m && Number(m[1]) === port && (!m[2] || m[2] === "/")) return { status: "ok" };
    return { status: "conflict", proxy };
  }
  return { status: "missing" };
}

export function tailscaleServeArgv(mount: string, port: number): string[] {
  return [
    "tailscale",
    "serve",
    "--bg",
    "--https=443",
    `--set-path=${mount}`,
    `http://127.0.0.1:${port}`,
  ];
}

export function tailscaleServeOffArgv(mount: string): string[] {
  return ["tailscale", "serve", "--https=443", `--set-path=${mount}`, "off"];
}

/** How to install portless with what's on PATH (npm first, as its docs say). */
export function portlessInstallArgv(has: (bin: string) => boolean): string[] | null {
  if (has("npm")) return ["npm", "install", "-g", "portless"];
  if (has("bun")) return ["bun", "add", "-g", "portless"];
  return null;
}

/** The one URL for the web console AND `ay connect` (HTTP modes). */
export function httpShareUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, "")}/#k=${encodeURIComponent(token)}`;
}
