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
 *   --webrtc <url>      / --webrtc=<url>   (a webrtc:// room url)
 *   --port <n>          / --port=<n>       (loopback HTTP console; 0 = free port)
 *   --sighost <host>    / --sighost=<host>
 *
 * What stays on TypeScript, with the reason printed:
 *   - `--no-rust` / AGENT_YES_NO_RUST=1 (explicit opt-out)
 *   - the bare `ay serve` (Portless HTTPS on agent-yes.localhost has no ayrs
 *     equivalent — `--port` is a plain loopback listener)
 *   - the daemon subcommands (install/uninstall/status/logs/start/stop/
 *     healthcheck) and -d/--daemon: ayrs has its own OS-supervisor install and
 *     the two must not manage each other's registration
 *   - --share (http+webrtc over Portless), --http, --host, --token, --tls-*,
 *     --local, https room links (ayrs pins rooms by webrtc:// url only)
 */

/** Subcommands `ay serve` dispatches before flag parsing — never delegated. */
const SERVE_SUBCOMMANDS = new Set([
  "install",
  "uninstall",
  "status",
  "logs",
  "start",
  "stop",
  "healthcheck",
]);

export type RustServePlan =
  | { kind: "rust"; argv: string[] }
  | { kind: "ts"; reason: string; rest: string[] };

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
  if (SERVE_SUBCOMMANDS.has(first)) {
    return { kind: "ts", reason: `\`ay serve ${first}\``, rest };
  }

  const argv = ["serve"];
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
        if (v === undefined) {
          argv.push("--webrtc");
        } else if (v.startsWith("webrtc://")) {
          argv.push("--webrtc", v);
        } else {
          return { kind: "ts", reason: `--webrtc ${v} (ayrs takes webrtc:// urls only)`, rest };
        }
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
      case "--sighost": {
        const v = takeNext();
        if (v === undefined) return { kind: "ts", reason: "--sighost (missing value)", rest };
        argv.push("--sighost", v);
        break;
      }
      default:
        return { kind: "ts", reason: a, rest };
    }
  }
  return { kind: "rust", argv };
}
