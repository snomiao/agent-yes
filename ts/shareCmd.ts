import { networkInterfaces } from "node:os";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  DEFAULT_SHARE_PORT,
  DEFAULT_TS_PATH,
  SHARE_MODES,
  type ShareMode,
  dropFlagWithValue,
  findTailscaleRoute,
  flagValue,
  hasFlag,
  httpShareUrl,
  pickLanIp,
  planDaemonArgs,
  portlessInstallArgv,
  tailscaleDnsName,
  tailscaleServeArgv,
  tailscaleServeOffArgv,
} from "./shareCore.ts";

// `ay share [local|portless|lan|tailscale|webrtc]` — guided "make this machine reachable".
// Picks HOW (a TTY picker when no mode is given), makes sure the serve daemon runs
// with the args that mode needs (delegating to `ay serve install`), and prints ONE
// URL that both opens the web console in a browser and is what another machine
// passes to `ay connect`. The HTTP modes carry the host's serve token in the
// fragment (#k=), the webrtc mode the room link — same secret for UI and CLI.
//
// Every command we'd run on the user's behalf — our own daemon install and,
// above all, third-party tools (tailscale, portless) — is printed verbatim and
// gated on a [y/N] prompt (default no), so what happens is exactly what they
// read. `--yes` is the scripted form of that consent; the commands still print.

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

const showCmd = (argv: string[]) => argv.map((a) => (/[\s'"$]/.test(a) ? `'${a}'` : a)).join(" ");

/**
 * Print the exact commands, then ask [y/N] (default NO). `--yes` answers yes;
 * without a TTY and without --yes it's a no, and the caller prints the manual
 * steps. Returns whether the user approved.
 */
async function confirmRun(why: string, cmds: string[][], yes: boolean): Promise<boolean> {
  process.stderr.write(`\n${why}\n${cmds.map((c) => `  $ ${showCmd(c)}\n`).join("")}`);
  if (yes) {
    process.stderr.write(`(--yes: running it)\n`);
    return true;
  }
  if (!(stdin.isTTY && stdout.isTTY)) return false;
  return /^y(es)?$/i.test(await ask(`run ${cmds.length > 1 ? "these" : "this"}? [y/N]: `));
}

async function runInherit(argv: string[]): Promise<number> {
  try {
    const p = Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"] });
    return (await p.exited) ?? 1;
  } catch (e) {
    process.stderr.write(`failed to run ${argv[0]}: ${(e as Error).message}\n`);
    return 1;
  }
}

/** GET <base>/api/version with the token — the end-to-end health check. */
async function probe(base: string, token: string): Promise<string | null> {
  try {
    const r = await fetch(`${base}/api/version`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    return r.ok ? null : `HTTP ${r.status}`;
  } catch (e) {
    return (e as Error).message;
  }
}

const HELP =
  `Usage: ay share [local|portless|lan|tailscale|webrtc] [options]\n` +
  `       ay share status\n\n` +
  `Make this machine's agents reachable and print ONE share URL: open it in a\n` +
  `browser for the web console, or pass it to \`ay connect\` on another machine.\n` +
  `With no mode (in a terminal) it asks which way to share.\n\n` +
  `Modes:\n` +
  `  local       http://127.0.0.1:<port> — this machine only\n` +
  `  portless    https://agent-yes.localhost — this machine, via portless (3rd-party)\n` +
  `  lan         http://<lan-ip>:<port> — anyone on your network (plain HTTP)\n` +
  `  tailscale   https://<machine>.<tailnet>.ts.net/ay/ — your tailnet devices,\n` +
  `              via \`tailscale serve\` (3rd-party)\n` +
  `  webrtc      https://agent-yes.com/w/#… — anywhere, end-to-end encrypted\n` +
  `              through the agent-yes.com signaling server\n\n` +
  `Every command ay would run for you (daemon install, tailscale, portless) is\n` +
  `shown first and needs a y at a [y/N] prompt.\n\n` +
  `Options:\n` +
  `  --port N      HTTP port (default: ${DEFAULT_SHARE_PORT}, or the daemon's)\n` +
  `  --path /ay    tailscale mount path (default: ${DEFAULT_TS_PATH})\n` +
  `  -y, --yes     approve the shown commands without prompting\n` +
  `  --json        print {mode, url} as JSON\n\n` +
  `The URL carries this host's serve token: whoever holds it can read and steer\n` +
  `every agent here. Rotate: rm ~/.agent-yes/.serve-token && ay serve install\n`;

// ay share status — end-to-end health of each way this machine is shared.
async function cmdShareStatus(mount: string): Promise<number> {
  const { inspectServeDaemon } = await import("./serve.ts");
  const [d, ts] = await Promise.all([inspectServeDaemon(), detectTailscale()]);
  const line = (k: string, v: string) => process.stdout.write(`${k.padEnd(11)}${v}\n`);
  if (d.args === null) {
    line("daemon:", "not installed — run `ay share`");
    return 1;
  }
  line("daemon:", `ay serve ${d.args.join(" ") || "(defaults: portless)"}`);
  const webrtc = hasFlag(d.args, "--webrtc") || hasFlag(d.args, "--share");
  line(
    "http:",
    d.port ? (d.httpUp ? `up on 127.0.0.1:${d.port}` : `DOWN (127.0.0.1:${d.port})`) : "off",
  );
  if (d.consoleUrl) line("portless:", d.httpUp ? d.consoleUrl.replace(/#.*/, "") : "DOWN");
  line("webrtc:", webrtc ? "on (agent-yes.com room)" : "off");
  if (!ts) {
    line("tailscale:", Bun.which("tailscale") ? "not running" : "not installed");
    return d.httpUp || webrtc ? 0 : 1;
  }
  const route = d.port
    ? findTailscaleRoute(ts.serveStatus, ts.dns, mount, d.port)
    : { status: "missing" as const };
  if (route.status !== "ok") {
    line(
      "tailscale:",
      route.status === "conflict" ? `${mount} → ${route.proxy} (not ay)` : `no ${mount} route`,
    );
    return d.httpUp || webrtc ? 0 : 1;
  }
  const base = `https://${ts.dns}${mount}`;
  const err = await probe(base, d.token);
  line("tailscale:", err ? `route ok, but ${base}/ FAILS: ${err}` : `${base}/ ok`);
  return err ? 1 : 0;
}

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

  if (positional[0] === "status") return cmdShareStatus(mount);
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
      { mode: "local", desc: "http://127.0.0.1 — this machine only", ok: true },
      {
        mode: "portless",
        desc: "https://agent-yes.localhost — this machine (3rd-party portless)",
        ok: true,
      },
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
    const def = ts ? 4 : 1;
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

  // 0. portless is a third-party dependency: offer to install it, never silently.
  if (mode === "portless" && !Bun.which("portless")) {
    const argv = portlessInstallArgv((b) => !!Bun.which(b));
    if (!argv) {
      process.stderr.write(
        `ay share: portless isn't installed and neither npm nor bun is on PATH\n`,
      );
      return 1;
    }
    if (
      !(await confirmRun("portless (third-party) isn't installed. To install it:", [argv], yes))
    ) {
      process.stderr.write(`not installed — run it yourself, then \`ay share portless\`\n`);
      return 1;
    }
    if ((await runInherit(argv)) !== 0 || !Bun.which("portless")) {
      process.stderr.write(`ay share: installing portless failed\n`);
      return 1;
    }
  }

  // 1. The daemon: install / reconfigure it when the mode needs different args.
  const want = planDaemonArgs(daemon.args, mode, portArg ? Number(portArg) : undefined);
  if (
    portArg &&
    mode !== "webrtc" &&
    mode !== "portless" &&
    flagValue(want, "--port") !== portArg
  ) {
    want.splice(0, want.length, ...dropFlagWithValue(want, "--port"), "--port", portArg);
  }
  const changed = JSON.stringify(want) !== JSON.stringify(daemon.args);
  const down = mode !== "webrtc" && !daemon.httpUp;
  let state = daemon;
  if (changed || down) {
    const why =
      daemon.args === null
        ? `no serve daemon yet — sharing needs one:`
        : changed
          ? `the serve daemon runs \`ay serve ${daemon.args.join(" ") || "(defaults)"}\`; ${mode} needs:`
          : `the serve daemon isn't answering — restart it:`;
    const note =
      mode === "portless"
        ? `\n(the daemon then runs under third-party portless: \`portless agent-yes ay serve …\`)`
        : "";
    if (!(await confirmRun(why + note, [["ay", "serve", "install", ...want]], yes))) {
      process.stderr.write(`not changed — run the command above, then \`ay share ${mode}\`\n`);
      return 1;
    }
    const code = await cmdServe(["install", ...want]);
    if (code !== 0) return code;
    state = await inspectServeDaemon();
  }

  // 2. The URL (+ for tailscale, the route and an end-to-end check).
  let url: string;
  const port = state.port ?? (portArg ? Number(portArg) : DEFAULT_SHARE_PORT);
  if (mode === "webrtc") {
    const { loadOrCreateShareRoom, shareLinkFromRoomUrl } = await import("./share.ts");
    url = shareLinkFromRoomUrl(await loadOrCreateShareRoom());
  } else if (mode === "portless") {
    url = state.consoleUrl ?? httpShareUrl("https://agent-yes.localhost", state.token);
  } else if (mode === "local") {
    url = httpShareUrl(`http://127.0.0.1:${port}`, state.token);
  } else if (mode === "lan") {
    url = httpShareUrl(`http://${lanIp}:${port}`, state.token);
  } else {
    const base = `https://${ts!.dns}${mount}`;
    url = httpShareUrl(base, state.token);
    const route = findTailscaleRoute(ts!.serveStatus, ts!.dns, mount, port);
    if (route.status !== "ok") {
      const cmds = [
        ...(route.status === "conflict" ? [tailscaleServeOffArgv(mount)] : []),
        tailscaleServeArgv(mount, port),
      ];
      const why =
        (route.status === "conflict"
          ? `${mount} on your tailnet already proxies to ${route.proxy}; to point it at ay instead`
          : `to route https://${ts!.dns}${mount}/ to ay (tailnet-only, TLS by tailscale)`) +
        `, ay will run third-party tailscale:`;
      if (await confirmRun(why, cmds, yes)) {
        for (const c of cmds) {
          if ((await runInherit(c)) !== 0) {
            process.stderr.write(
              `ay share: \`${showCmd(c)}\` failed. "Access denied"? allow your user once:\n` +
                `  sudo tailscale set --operator=$USER\n`,
            );
            return 1;
          }
        }
      } else {
        process.stderr.write(
          `not changed — run the command(s) above yourself, then \`ay share status\`\n`,
        );
      }
    }
    // Health: the route actually reaches THIS daemon with THIS token, end to end.
    const err = await probe(base, state.token);
    say(
      err
        ? `\nhealth: ${base}/ not reachable yet (${err}) — check \`ay share status\`\n`
        : `\nhealth: ${base}/ ok\n`,
    );
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
