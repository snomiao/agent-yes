// `ay term` — embed a LIVE, read-only agent-session terminal in any web page.
//
// The terminal sibling of `ay ch`. `ay term embed <pid>` prints a <script> that
// loads the AyTerminal widget (terminal/browser.ts) and renders a read-only
// xterm mirror of the agent's PTY, streamed from the serving `ay serve` daemon's
// `/api/tail/<pid>?raw=1` SSE endpoint.
//
// PHASE 1 = SAME-ORIGIN. `/api/tail` is token-gated and emits no CORS headers, so
// the embedding page must be served same-origin with the daemon (`ay serve --http`),
// or the token/origin must be provided AND the daemon reachable. Cross-origin
// arbitrary pages (via the WebRTC `--share` transport) are a later phase.

type FlagSpec = Record<string, "bool" | "value">;

function parseFlags(
  args: string[],
  known: FlagSpec,
): { flags: Record<string, string | boolean>; positional: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("-") || a === "-") {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq === -1 ? a.replace(/^--?/, "") : a.slice(a.startsWith("--") ? 2 : 1, eq);
    const kind = known[name];
    if (!kind) throw new Error(`unknown flag ${a}`);
    if (kind === "bool") {
      if (eq !== -1) throw new Error(`--${name} takes no value`);
      flags[name] = true;
    } else {
      const v = eq !== -1 ? a.slice(eq + 1) : args[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      flags[name] = v;
    }
  }
  return { flags, positional };
}

export interface TermEmbedOpts {
  origin?: string;
  /** Wire keyboard input to the agent (opt-in). Needs a token that grants /api/send for this pid. */
  interactive?: boolean;
}
export type TermEmbedMode =
  | ({ kind: "discover" } & TermEmbedOpts) // no token in the file — widget reads it from the page
  | ({ kind: "placeholder" } & TermEmbedOpts) // window.AY_TERM_TOKEN injected at runtime
  | ({ kind: "live"; token: string } & TermEmbedOpts); // token baked into the file

/**
 * The embed `<script>` snippet — a script (NOT an iframe) that loads the AyTerminal
 * browser lib and mounts a read-only terminal in the page. Three modes trade off
 * where the serve token lives: never in the file (`discover` — the safe default,
 * the widget reads #k= / window.AY_TERM_TOKEN / localStorage), injected at runtime
 * (`placeholder`), or baked in (`live`, loud warning — a serve token is full-fleet
 * read+write until scoped read-only tokens land).
 */
export function buildTermEmbedSnippet(host: string, pid: string, mode: TermEmbedMode): string {
  const imp = `  import AyTerminal from "https://${host}/w/terminal.js";\n`;
  const originArg = mode.origin ? `origin: ${JSON.stringify(mode.origin)}, ` : "";
  // interactive is opt-in; the widget only wires the keyboard when readOnly:false
  // AND the token actually grants /api/send (a 403 reverts it to a mirror).
  const roArg = mode.interactive ? `readOnly: false, ` : "";
  const tokenArg =
    mode.kind === "live"
      ? `token: ${JSON.stringify(mode.token)}, `
      : mode.kind === "placeholder"
        ? `token: window.AY_TERM_TOKEN, `
        : "";
  // mount into <div id="ay-term">…</div> if the page has one, else float in the corner
  const tail = `.mount(document.getElementById("ay-term") ?? undefined);`;
  const hint =
    `Add <div id="ay-term" style="width:720px;height:420px"></div> where you want the ` +
    `terminal, or omit it to float in the corner.`;
  const kindLabel = mode.interactive ? "interactive" : "read-only";
  const tokenNote =
    mode.kind === "live"
      ? `this snippet embeds a LIVE token — do NOT commit it to a public or deploy-bound file.`
      : mode.kind === "placeholder"
        ? `set window.AY_TERM_TOKEN at runtime; do NOT commit it.`
        : `no token in this file; the widget reads it from the page (#k= / window.AY_TERM_TOKEN / localStorage).`;
  return (
    `<!-- ay terminal: ${kindLabel} view of #${pid} — ${tokenNote} ${hint} -->\n` +
    `<script type="module">\n${imp}` +
    `  new AyTerminal({ ${originArg}${roArg}${tokenArg}pid: ${JSON.stringify(pid)} })${tail}\n` +
    `</script>\n`
  );
}

function cmdTermEmbed(args: string[]): number {
  const { flags, positional } = parseFlags(args, {
    host: "value",
    origin: "value",
    token: "value",
    placeholder: "bool",
    interactive: "bool",
  });
  const pid = positional[0];
  if (!pid || positional.length > 1)
    throw new Error(
      "usage: ay term embed <pid|keyword> [--host H] [--origin URL] [--token TOK | --placeholder] [--interactive]",
    );
  if (flags.token && flags.placeholder)
    throw new Error("--token and --placeholder are mutually exclusive");
  const host = typeof flags.host === "string" ? flags.host : "agent-yes.com";
  const origin = typeof flags.origin === "string" ? flags.origin : undefined;
  const interactive = flags.interactive === true;
  const mode: TermEmbedMode = flags.placeholder
    ? { kind: "placeholder", origin, interactive }
    : typeof flags.token === "string"
      ? { kind: "live", token: flags.token, origin, interactive }
      : { kind: "discover", origin, interactive };

  // stdout: only the snippet (safe to pipe/paste). stderr: the guidance.
  process.stdout.write(buildTermEmbedSnippet(host, pid, mode));

  if (mode.kind === "discover") {
    process.stderr.write(
      `\n  Token-free snippet — the widget reads the serve token from the page (#k= hash,\n` +
        `  window.AY_TERM_TOKEN, or the console's localStorage["ay.localToken"]). Ideal when the\n` +
        `  page is served by the daemon itself (ay serve --http) with a #k=<token> link.\n`,
    );
  } else if (mode.kind === "placeholder") {
    process.stderr.write(
      `\n  Placeholder — the token is NOT in the snippet; set window.AY_TERM_TOKEN at runtime\n` +
        `  (server-rendered / env), so a committed file carries no secret.\n`,
    );
  } else {
    process.stderr.write(
      `\n  ⚠ This snippet embeds a LIVE serve token — full-fleet READ+WRITE for this daemon.\n` +
        `    Anyone who reads the page source gets it. Do NOT commit it to a public or\n` +
        `    deploy-bound file. Prefer --placeholder (runtime-injected) or the token-free\n` +
        `    default. Scoped read-only embed tokens are future work (need per-author signing).\n`,
    );
  }
  if (interactive) {
    process.stderr.write(
      `\n  ⚠ INTERACTIVE: keystrokes in the widget go to the agent's stdin. This needs a token\n` +
        `    that grants /api/send for #${pid} (the widget reverts to read-only on a 403). Prefer a\n` +
        `    scoped, short-TTL, single-session interactive token (future: ay term mint --interactive)\n` +
        `    over the master token — the master token is full-fleet RCE.\n`,
    );
  } else {
    process.stderr.write(
      `\n  Read-only mirror: it renders the agent's PTY but never types into it. Add --interactive\n` +
        `  (with a send-granting token) to let viewers type to the agent.\n`,
    );
  }
  process.stderr.write(`  terminal.js must load from https://${host}/w/terminal.js.\n`);
  if (!origin) {
    process.stderr.write(
      `  Same-origin: /api/tail sends no CORS headers, so the page must be served by the\n` +
        `  daemon (ay serve --http). For an arbitrary-origin page, pass --origin <daemon-url>\n` +
        `  (the daemon must be reachable + allow it); the WebRTC --share transport for any\n` +
        `  origin is a later phase.\n`,
    );
  }
  return 0;
}

function termHelp(): number {
  process.stdout.write(
    `ay term — embed a live, read-only agent terminal in a web page\n\n` +
      `Usage:\n` +
      `  ay term embed <pid|keyword> [--host H] [--origin URL] [--token TOK | --placeholder]\n\n` +
      `  embed   print a <script> snippet that mounts a read-only xterm mirror of the agent\n` +
      `          into <div id="ay-term">, or a floating panel if that div is absent.\n\n` +
      `Flags:\n` +
      `  --host H        CDN host serving terminal.js (default agent-yes.com)\n` +
      `  --origin URL    daemon origin if the page is NOT served by the daemon (same-origin default)\n` +
      `  --token TOK     bake a LIVE serve token into the snippet (⚠ full-fleet r/w; avoid committing)\n` +
      `  --placeholder   read the token from window.AY_TERM_TOKEN at runtime (no secret in the file)\n` +
      `  --interactive   wire the keyboard to the agent's stdin (needs a send-granting token; ⚠ opt-in)\n`,
  );
  return 0;
}

export async function cmdTerm(args: string[]): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "embed":
      return cmdTermEmbed(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return termHelp();
    default:
      process.stderr.write(`ay term: unknown subcommand "${sub}"\n\n`);
      termHelp();
      return 1;
  }
}
