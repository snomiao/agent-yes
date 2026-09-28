import { networkInterfaces } from "node:os";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

// `ay share [local|lan|tailscale|webrtc]` — guided "make this machine reachable".
// Picks HOW (a TTY picker when no mode is given), makes sure the serve daemon runs
// with the args that mode needs (delegating to `ay serve install`), and prints ONE
// URL that both opens the web console in a browser and is what another machine
// passes to `ay connect`. The HTTP modes carry the host's serve token in the
// fragment (#k=), the webrtc mode the room link — same secret for UI and CLI.
//
// Tailscale is guide-only: we detect the tailnet name and an existing
// `tailscale serve` route, and print the command to add one — changing the
// operator's tailnet config is left to them.

export type ShareMode = "local" | "lan" | "tailscale" | "webrtc";
export const SHARE_MODES: ShareMode[] = ["local", "lan", "tailscale", "webrtc"];
export const DEFAULT_SHARE_PORT = 7432;
export const DEFAULT_TS_PATH = "/ay";

function flagValue(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === flag) return args[i + 1];
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.some((a) => a === flag || a.startsWith(`${flag}=`));
}

function dropFlagWithValue(args: string[], flag: string): string[] {
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
  // local is fine on Portless (no fixed port); lan/tailscale need a stable port
  // to point the LAN or the tailscale proxy at.
  if (mode !== "local" && flagValue(args, "--port") === undefined)
    args.push("--port", String(defaultPort));
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

export function tailscaleServeCommand(mount: string, port: number): string {
  return `tailscale serve --bg --https=443 --set-path=${mount} http://127.0.0.1:${port}`;
}

/** The one URL for the web console AND `ay connect` (HTTP modes). */
export function httpShareUrl(base: string, token: string): string {
  return `${base.replace(/\/+$/, "")}/#k=${encodeURIComponent(token)}`;
}

// Spawn a CLI that prints JSON, with a deadline. On timeout the reader is
// abandoned, not awaited (see CLAUDE.md: a grandchild may hold the pipe open).
async function runJson(cmd: string[], timeoutMs = 4000): Promise<any | null> {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const text = await Promise.race([
      new Response(p.stdout).text(),
      new Promise<null>((r) => (timer = setTimeout(() => r(null), timeoutMs))),
    ]);
    clearTimeout(timer);
    if (text === null) {
      p.kill();
      return null;
    }
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function detectTailscale(): Promise<{ dns: string; serveStatus: any } | null> {
  if (!Bun.which("tailscale")) return null;
  const dns = tailscaleDnsName(await runJson(["tailscale", "status", "--json"]));
  if (!dns) return null;
  return { dns, serveStatus: await runJson(["tailscale", "serve", "status", "--json"]) };
}

async function ask(q: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(q)).trim();
  } finally {
    rl.close();
  }
}

const HELP =
  `Usage: ay share [local|lan|tailscale|webrtc] [options]\n\n` +
  `Make this machine's agents reachable and print ONE share URL: open it in a\n` +
  `browser for the web console, or pass it to \`ay connect\` on another machine.\n` +
  `With no mode (in a terminal) it asks which way to share.\n\n` +
  `Modes:\n` +
  `  local       this machine only (loopback)\n` +
  `  lan         http://<lan-ip>:<port> — anyone on your network (plain HTTP)\n` +
  `  tailscale   https://<machine>.<tailnet>.ts.net/ay/ — your tailnet devices;\n` +
  `              prints the \`tailscale serve\` command to run (doesn't run it)\n` +
  `  webrtc      https://agent-yes.com/w/#… — anywhere, end-to-end encrypted\n` +
  `              through the agent-yes.com signaling server\n\n` +
  `Options:\n` +
  `  --port N      HTTP port for lan/tailscale (default: ${DEFAULT_SHARE_PORT}, or the daemon's)\n` +
  `  --path /ay    tailscale mount path (default: ${DEFAULT_TS_PATH})\n` +
  `  -y, --yes     (re)install the serve daemon without asking\n` +
  `  --json        print {mode, url} as JSON\n\n` +
  `The URL carries this host's serve token: whoever holds it can read and steer\n` +
  `every agent here. Rotate: rm ~/.agent-yes/.serve-token && ay serve install\n`;

export async function cmdShare(rest: string[]): Promise<number> {
  if (rest.includes("-h") || rest.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  const json = rest.includes("--json");
  const yes = rest.includes("-y") || rest.includes("--yes");
  const portArg = flagValue(rest, "--port");
  const mount = "/" + (flagValue(rest, "--path") ?? DEFAULT_TS_PATH).replace(/^\/+|\/+$/g, "");
  const valueIdx = new Set(
    ["--port", "--path"]
      .map((f) => rest.indexOf(f))
      .filter((i) => i >= 0)
      .map((i) => i + 1),
  );
  const positional = rest.filter((a, i) => !a.startsWith("-") && !valueIdx.has(i));
  const say = (s: string) => (json ? process.stderr : process.stdout).write(s);

  let mode = positional[0] as ShareMode | undefined;
  if (mode && !SHARE_MODES.includes(mode)) {
    process.stderr.write(`ay share: unknown mode '${mode}' — one of ${SHARE_MODES.join(", ")}\n`);
    return 1;
  }

  const { inspectServeDaemon, cmdServe } = await import("./serve.ts");
  const [daemon, ts] = await Promise.all([inspectServeDaemon(), detectTailscale()]);
  const lanIp = pickLanIp(networkInterfaces());

  if (!mode) {
    const opts: { mode: ShareMode; desc: string; ok: boolean }[] = [
      { mode: "local", desc: "this machine only", ok: true },
      {
        mode: "lan",
        desc: lanIp ? `http://${lanIp}:<port> — your network, plain HTTP` : "no LAN address found",
        ok: !!lanIp,
      },
      {
        mode: "tailscale",
        desc: ts ? `https://${ts.dns}${mount}/ — your tailnet` : "tailscale not installed/running",
        ok: !!ts,
      },
      { mode: "webrtc", desc: "agent-yes.com link — anywhere, e2e encrypted", ok: true },
    ];
    const def = ts ? 3 : 1;
    if (!(stdin.isTTY && stdout.isTTY)) {
      process.stderr.write(`ay share: pick a mode — ${SHARE_MODES.join(" | ")}\n\n` + HELP);
      return 1;
    }
    say(`How should this machine be shared?\n`);
    opts.forEach((o, i) =>
      say(`  ${i + 1}) ${o.mode.padEnd(10)} ${o.desc}${o.ok ? "" : "  (unavailable)"}\n`),
    );
    const ans = await ask(`choose [${def}]: `);
    const n = ans ? Number(ans) : def;
    const picked = opts[n - 1] ?? opts.find((o) => o.mode === ans);
    if (!picked || !picked.ok) {
      process.stderr.write(`ay share: '${ans}' is not an available choice\n`);
      return 1;
    }
    mode = picked.mode;
  }
  if (mode === "lan" && !lanIp) {
    process.stderr.write(`ay share: no private LAN IPv4 address found on this machine\n`);
    return 1;
  }
  if (mode === "tailscale" && !ts) {
    process.stderr.write(
      `ay share: tailscale isn't running here — install it and \`tailscale up\` first\n` +
        `  https://tailscale.com/download\n`,
    );
    return 1;
  }

  // 1. The daemon: install / reconfigure it when the mode needs different args.
  const want = planDaemonArgs(daemon.args, mode, portArg ? Number(portArg) : undefined);
  if (portArg && mode !== "webrtc" && flagValue(want, "--port") !== portArg) {
    want.splice(0, want.length, ...dropFlagWithValue(want, "--port"), "--port", portArg);
  }
  const changed = JSON.stringify(want) !== JSON.stringify(daemon.args);
  const down = mode !== "webrtc" && !daemon.httpUp;
  let state = daemon;
  if (changed || down) {
    const cmd = `ay serve install ${want.join(" ")}`.trim();
    say(
      daemon.args === null
        ? `\nno serve daemon yet — sharing needs one:\n  ${cmd}\n`
        : changed
          ? `\nthe serve daemon runs \`${daemon.args.join(" ") || "(defaults)"}\`; ${mode} needs:\n  ${cmd}\n`
          : `\nthe serve daemon isn't answering — restart it:\n  ${cmd}\n`,
    );
    let go = yes;
    if (!go && stdin.isTTY && stdout.isTTY) go = !/^n(o)?$/i.test(await ask(`run it now? [Y/n]: `));
    if (!go) {
      process.stderr.write(
        `not changed — run the command above (or pass --yes), then \`ay share ${mode}\`\n`,
      );
      return 1;
    }
    const code = await cmdServe(["install", ...want]);
    if (code !== 0) return code;
    state = await inspectServeDaemon();
  }

  // 2. The URL.
  let url: string;
  const port = state.port ?? (portArg ? Number(portArg) : DEFAULT_SHARE_PORT);
  if (mode === "webrtc") {
    const { loadOrCreateShareRoom, shareLinkFromRoomUrl } = await import("./share.ts");
    url = shareLinkFromRoomUrl(await loadOrCreateShareRoom());
  } else if (mode === "local") {
    url = state.consoleUrl ?? httpShareUrl(`http://127.0.0.1:${port}`, state.token);
  } else if (mode === "lan") {
    url = httpShareUrl(`http://${lanIp}:${port}`, state.token);
  } else {
    url = httpShareUrl(`https://${ts!.dns}${mount}`, state.token);
    const route = findTailscaleRoute(ts!.serveStatus, ts!.dns, mount, port);
    if (route.status !== "ok") {
      say(
        `\n${route.status === "conflict" ? `${mount} is already proxied to ${route.proxy} — replace it` : `one step left — route ${mount} on your tailnet to ay`}:\n` +
          (route.status === "conflict"
            ? `  tailscale serve --https=443 --set-path=${mount} off\n`
            : ``) +
          `  ${tailscaleServeCommand(mount, port)}\n` +
          `(tailnet-only, TLS by Tailscale's ts.net cert. "Access denied"? run once:\n` +
          `  sudo tailscale set --operator=$USER)\n` +
          `then re-run \`ay share tailscale\` to check the route.\n`,
      );
    } else say(`\ntailscale route ok: https://${ts!.dns}${mount}/ → 127.0.0.1:${port}\n`);
  }

  if (json) {
    process.stdout.write(JSON.stringify({ mode, url }) + "\n");
    return 0;
  }
  say(
    `\nshare URL (web console + CLI, same token):\n  ${url}\n\n` +
      `open it in a browser, or from another machine:\n  ay connect '${url}'\n` +
      (mode === "lan"
        ? `\nnote: plain HTTP — the token is visible to anyone sniffing this network.\n`
        : ``) +
      `anyone with this URL can read and steer every agent here.\n`,
  );
  return 0;
}
