/**
 * `ay serve` → `ayrs serve` delegation.
 *
 * Mirrors how `ay <cli>` runs the Rust agent runtime by default and only falls
 * back to TypeScript on `--no-rust`: the Rust serve daemon (`ayrs`) becomes the
 * default for every invocation it can express, and the TypeScript server keeps
 * everything it can't (yet). The decision is a pure function of the argv so the
 * contract is testable and the fallback reason is explicit — a silent fallback
 * would leave an operator unsure which daemon they are looking at.
 *
 * What delegates today — exactly the flags `ayrs serve` accepts:
 *   --webrtc            (bare: load/mint the persisted room)
 *   --webrtc <link>     / --webrtc=<link>  (a room link, any spelling; passed on
 *                                          as webrtc://)
 *   --join              (host that room as one of its members; ayrs only;
 *                        with a bare --webrtc the link comes from AY_ROOM_URL,
 *                        else AY_ROOM)
 *   join-secret [--new] (print the link + join secret members need; --new
 *                        mints a fresh fleet token instead; ayrs only)
 *   --port <n>          / --port=<n>       (loopback HTTP console; 0 = free port)
 *   --sighost <host>    / --sighost=<host>
 *   --http              (with --port: ayrs's --port listener IS the HTTP
 *                        console, so the flag is implied and dropped)
 *   --host <loopback>   (with --port: 127.0.0.1 / localhost / ::1 — ayrs
 *                        binds loopback anyway, so the flag is dropped)
 *   --ice-public-ip <ip>|auto  (repeatable / comma list; the address(es)
 *                        viewers should reach this host at. `auto` = the
 *                        STUN-seen public IP plus `tailscale ip -4` when
 *                        tailscale is present. → AGENT_YES_ICE_PUBLIC_IPS)
 *   --ice-udp-port <n>  (one UDP port for every viewer, for a published
 *                        container port. → AGENT_YES_ICE_UDP_PORT)
 *     Both are daemon args rather than env, so `ay serve install` persists
 *     them in the registration and they survive restarts.
 *
 * What stays on TypeScript, with the reason printed:
 *   - `--no-rust` / AGENT_YES_NO_RUST=1 (explicit opt-out)
 *   - the bare `ay serve` (Portless HTTPS on agent-yes.localhost has no ayrs
 *     equivalent — `--port` is a plain loopback listener)
 *   - the daemon subcommands (install/uninstall/status/logs/start/stop/
 *     restart/healthcheck) and -d/--daemon: ayrs has its own OS-supervisor install and
 *     the two must not manage each other's registration
 *   - --share (http+webrtc over Portless), --http without --port (Portless),
 *     a non-loopback --host (ayrs listens on loopback only), --token, --tls-*,
 *     --local
 */

/** Subcommands `ay serve` dispatches before flag parsing — never delegated. */
import { toWebrtcUrl } from "./webrtcLink.ts";

export const SERVE_SUBCOMMANDS = new Set([
  "install",
  "uninstall",
  "status",
  "logs",
  "start",
  "stop",
  "restart",
  "healthcheck",
]);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** The ICE flags, as given; `iceEnv` turns them into the ayrs env. */
export type IceFlags = { publicIps: string[]; udpPort?: string };

export type RustServePlan =
  | { kind: "rust"; argv: string[]; ice?: IceFlags }
  | { kind: "ts"; reason: string; rest: string[] }
  /** Only ayrs can do this; there is no TypeScript fallback. */
  | { kind: "rust-only"; argv: string[]; feature: string; ice?: IceFlags };

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const isIp = (s: string) =>
  IPV4.test(s)
    ? s.split(".").every((n) => Number(n) <= 255)
    : /^[0-9a-fA-F:]+:[0-9a-fA-F:.]*$/.test(s);

/**
 * The env ayrs reads its ICE settings from (rs/src/serve/ice_net.rs).
 * `auto` keeps the STUN lookup (ayrs does it) and adds this host's tailnet
 * IPv4 when there is one: a container on a userspace-networking tailnet has
 * no interface carrying that address, so nothing else would advertise it.
 */
export function iceEnv(ice: IceFlags | undefined, tailscaleIp4: () => string | undefined) {
  const env: Record<string, string> = {};
  if (!ice) return env;
  const ips: string[] = [];
  for (const ip of ice.publicIps) {
    if (ip.toLowerCase() === "auto") {
      ips.push("auto");
      const ts = tailscaleIp4();
      if (ts) ips.push(ts);
    } else ips.push(ip);
  }
  const uniq = [...new Set(ips)];
  if (uniq.length) env.AGENT_YES_ICE_PUBLIC_IPS = uniq.join(",");
  if (ice.udpPort) env.AGENT_YES_ICE_UDP_PORT = ice.udpPort;
  return env;
}

/**
 * Decide whether `rest` (the argv after `serve`) can run as `ayrs serve`.
 * Returns the ayrs argv (without the program) or the TS fallback with its
 * reason and the argv the TS path should parse (`--no-rust` stripped).
 */
export function planRustServe(
  rest: string[],
  env: Record<string, string | undefined> = process.env,
): RustServePlan {
  const stripped = rest.filter((a) => a !== "--no-rust");
  if (stripped.length !== rest.length) {
    return { kind: "ts", reason: "--no-rust", rest: stripped };
  }
  if (env.AGENT_YES_NO_RUST === "1") {
    return { kind: "ts", reason: "AGENT_YES_NO_RUST=1", rest };
  }
  if (rest.length === 0) {
    return { kind: "ts", reason: "bare `ay serve` (Portless HTTPS console)", rest };
  }
  const first = rest[0]!;
  if (first === "join-secret") {
    // --new mints a fresh fleet token (AY_ROOM_URL + AY_JOIN_SECRET) and
    // writes nothing; it only takes --sighost.
    const isNew = rest.includes("--new");
    const flags = rest.slice(1).filter((a) => a !== "--new");
    if (isNew && flags.some((a) => a === "--webrtc" || a.startsWith("--webrtc=")))
      return { kind: "ts", reason: "`ay serve join-secret --new` takes only --sighost", rest };
    const plan = flags.length
      ? planRustServe(flags, env)
      : ({ kind: "rust", argv: ["serve"] } as const);
    if (plan.kind !== "rust" || plan.argv.some((a) => a === "--port" || a === "--join"))
      return { kind: "ts", reason: `\`ay serve join-secret\` takes only --webrtc/--sighost`, rest };
    return {
      kind: "rust-only",
      argv: [...plan.argv, "join-secret", ...(isNew ? ["--new"] : [])],
      feature: first,
    };
  }
  if (SERVE_SUBCOMMANDS.has(first)) {
    return { kind: "ts", reason: `\`ay serve ${first}\``, rest };
  }

  // `--http`/`--host` only map onto ayrs next to an explicit port: without
  // one, TypeScript's HTTP console runs behind Portless, which ayrs lacks.
  const hasPort = rest.some((a) => a === "--port" || a.startsWith("--port="));
  const argv = ["serve"];
  let ice: IceFlags | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const eq = a.indexOf("=");
    const name = eq === -1 ? a : a.slice(0, eq);
    const inline = eq === -1 ? undefined : a.slice(eq + 1);
    // A following token is this flag's value unless it looks like another flag.
    const next = rest[i + 1];
    const takeNext = () => {
      if (inline !== undefined) return inline;
      if (next !== undefined && !next.startsWith("-")) {
        i++;
        return next;
      }
      return undefined;
    };
    switch (name) {
      case "--webrtc": {
        const v = takeNext();
        const url = v === undefined ? undefined : toWebrtcUrl(v, { join: true });
        if (v === undefined) {
          argv.push("--webrtc");
        } else if (url) {
          argv.push("--webrtc", url);
        } else {
          return { kind: "ts", reason: `--webrtc ${v} (not a room link)`, rest };
        }
        break;
      }
      case "--join": {
        if (inline !== undefined) return { kind: "ts", reason: a, rest };
        argv.push("--join");
        break;
      }
      case "--port": {
        const v = takeNext();
        if (v === undefined || !/^\d+$/.test(v)) {
          return { kind: "ts", reason: `--port ${v ?? "(missing)"}`, rest };
        }
        argv.push("--port", v);
        break;
      }
      case "--http": {
        if (inline !== undefined || !hasPort)
          return { kind: "ts", reason: `${a} without --port (Portless HTTPS console)`, rest };
        break; // ayrs's --port listener is the HTTP console
      }
      case "--host": {
        const v = takeNext();
        if (v === undefined || !LOOPBACK_HOSTS.has(v) || !hasPort)
          return {
            kind: "ts",
            reason: `--host ${v ?? "(missing)"} (ayrs listens on loopback only)`,
            rest,
          };
        break; // ayrs binds 127.0.0.1 already
      }
      case "--sighost": {
        const v = takeNext();
        if (v === undefined) return { kind: "ts", reason: "--sighost (missing value)", rest };
        argv.push("--sighost", v);
        break;
      }
      case "--ice-public-ip": {
        const v = takeNext();
        const ips = (v ?? "")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
        const bad = ips.find((x) => x.toLowerCase() !== "auto" && !isIp(x));
        if (!ips.length || bad)
          return { kind: "ts", reason: `--ice-public-ip ${bad ?? v ?? "(missing)"}`, rest };
        ice = { publicIps: [...(ice?.publicIps ?? []), ...ips], udpPort: ice?.udpPort };
        break;
      }
      case "--ice-udp-port": {
        const v = takeNext();
        if (v === undefined || !/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 65535)
          return { kind: "ts", reason: `--ice-udp-port ${v ?? "(missing)"}`, rest };
        ice = { publicIps: ice?.publicIps ?? [], udpPort: v };
        break;
      }
      default:
        return { kind: "ts", reason: a, rest };
    }
  }
  if (ice && !argv.includes("--webrtc"))
    return { kind: "ts", reason: "--ice-* flags need --webrtc", rest };
  if (argv.includes("--join")) {
    // A bare --webrtc is fine: ayrs reads the link from AY_ROOM_URL / AY_ROOM,
    // which keeps it (and the view secret it carries) out of argv.
    if (!argv.includes("--webrtc"))
      return { kind: "ts", reason: "--join needs --webrtc [room link]", rest };
    return { kind: "rust-only", argv, feature: "--join", ...(ice ? { ice } : {}) };
  }
  return { kind: "rust", argv, ...(ice ? { ice } : {}) };
}

/**
 * Which runtime a daemon registered with these `ay serve` args actually runs —
 * and therefore which persisted room file holds the room it hosts
 * (`.share-room` for TypeScript, `.share-room-ayrs` for ayrs; see share.ts).
 *
 * Mirrors cmdServe exactly: an argv that planRustServe delegates runs under
 * ayrs whenever the binary exists, and falls back to TypeScript otherwise. Any
 * link we print for a daemon must be derived through this, or `ay share` hands
 * out a link to a room nobody serves. `hasAyrs` is injected so the decision
 * stays a pure function for tests.
 */
export function daemonShareRuntime(
  args: string[],
  hasAyrs: () => boolean,
  env: Record<string, string | undefined> = process.env,
): "ts" | "rust" {
  return planRustServe(args, env).kind !== "ts" && hasAyrs() ? "rust" : "ts";
}

/**
 * daemonShareRuntime for a caller that is about to MINT (or print) the room
 * for a daemon it is installing. The daemon's `ay serve --webrtc` fetches ayrs
 * when it is missing (ensureAyrsBinary) and then hosts the Rust room, so a
 * plain "does ayrs exist yet?" check here is wrong on exactly the first run:
 * on a fresh box the binary is not downloaded yet, the TS room gets minted and
 * printed, and the daemon comes up a second later in a different room. Fetch
 * it the same way the daemon will, then decide.
 */
export async function ensureDaemonShareRuntime(
  args: string[],
  ensureAyrs: () => Promise<string | undefined>,
  env: Record<string, string | undefined> = process.env,
): Promise<"ts" | "rust"> {
  if (planRustServe(args, env).kind === "ts") return "ts";
  return (await ensureAyrs()) ? "rust" : "ts";
}
