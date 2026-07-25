// `ay widget` — read what a viewer is looking at, through an opted-in page widget.
//
// Agent-side CLI over the daemon's widget broker (serve.ts /api/widget/*). The
// page embeds `new AyWidget({sensors:[…]})` (widget/browser.ts); this reads it:
//   ay widget ls                         # online viewers
//   ay widget read selection <viewer>    # what the viewer has selected
//   ay widget read dom <viewer> --selector <css>
// Complements rechrome (rech drives any page; this reads an author-opted-in page,
// cross-origin / WebRTC-remote, no extension). Verb `read` matches `ay read`/`tail`.

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

/** Resolve the local daemon base URL + token (flags override discovery). */
async function daemonTarget(
  flags: Record<string, string | boolean>,
): Promise<{ base: string; token: string }> {
  const { resolveDaemonHttpBase, loadTokenReadOnly } = await import("./serve.ts");
  const base = typeof flags.base === "string" ? flags.base : await resolveDaemonHttpBase();
  if (!base)
    throw new Error(
      "no running ay serve daemon found — start `ay serve` or pass --base <url> (e.g. http://127.0.0.1:PORT)",
    );
  const token = typeof flags.token === "string" ? flags.token : ((await loadTokenReadOnly()) ?? "");
  if (!token) throw new Error("no serve token — pass --token or run `ay serve` once");
  return { base: base.replace(/\/+$/, ""), token };
}

function withTok(url: string, token: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

async function cmdWidgetLs(args: string[]): Promise<number> {
  const { flags } = parseFlags(args, { json: "bool", base: "value", token: "value" });
  const { base, token } = await daemonTarget(flags);
  const res = await fetch(withTok(`${base}/api/widget/list`, token), {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`widget list failed: ${res.status} ${await res.text()}`);
  const list = (await res.json()) as Array<{
    id: string;
    url: string;
    title: string;
    caps: string[];
    age: number;
  }>;
  if (flags.json) {
    process.stdout.write(JSON.stringify(list, null, 2) + "\n");
    return 0;
  }
  if (!list.length) {
    process.stderr.write("no online widgets (a page must embed AyWidget and start() it)\n");
    return 0;
  }
  for (const v of list) {
    process.stdout.write(
      `${v.id.padEnd(12)}  ${(v.title || "(untitled)").slice(0, 28).padEnd(28)}  ` +
        `caps:${v.caps.join(",") || "-"}  ${v.age}s  ${v.url}\n`,
    );
  }
  return 0;
}

async function cmdWidgetRead(args: string[]): Promise<number> {
  const { flags, positional } = parseFlags(args, {
    selector: "value",
    all: "bool",
    text: "bool",
    html: "bool",
    json: "bool",
    viewport: "bool",
    selection: "bool",
    out: "value",
    base: "value",
    token: "value",
  });
  const kind = positional[0];
  const viewer = positional[1];
  if (!kind || !viewer)
    throw new Error(
      "usage: ay widget read <selection|dom|screenshot> <viewer> [--selector <css>] [--all] [--text|--html] " +
        "[--viewport|--selection] [--out f.png] [--json]",
    );
  const cmdArgs: Record<string, unknown> = {};
  if (kind === "dom") {
    if (typeof flags.selector !== "string") throw new Error("dom read needs --selector <css>");
    cmdArgs.selector = flags.selector;
    cmdArgs.all = flags.all === true;
  }
  if (kind === "screenshot") {
    // exactly one region mode; --selector implies selector mode, else --selection, else --viewport
    cmdArgs.mode =
      typeof flags.selector === "string" ? "selector" : flags.selection ? "selection" : "viewport";
    if (cmdArgs.mode === "selector") cmdArgs.selector = flags.selector;
  }
  const { base, token } = await daemonTarget(flags);
  const res = await fetch(withTok(`${base}/api/widget/read`, token), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ viewer, kind, args: cmdArgs }),
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`widget read failed: ${res.status} ${JSON.stringify(body)}`);
  if (body.error) {
    process.stderr.write(`read ${kind} @ ${body.viewer ?? viewer}: ${body.error}\n`);
    return 1;
  }
  // Screenshot: --out writes the PNG; else --json gives the envelope; else a summary
  // (the base64 is large, so we don't dump it by default).
  if (kind === "screenshot") {
    const d = body.data ?? {};
    if (typeof flags.out === "string") {
      const { writeFile } = await import("fs/promises");
      const buf = Buffer.from(String(d.b64 ?? ""), "base64");
      await writeFile(flags.out, buf);
      process.stderr.write(`wrote ${buf.length} bytes → ${flags.out} (${d.w}×${d.h} ${d.mime})\n`);
      return 0;
    }
    if (flags.json) {
      process.stdout.write(JSON.stringify(body, null, 2) + "\n");
      return 0;
    }
    const bytes = Math.round((String(d.b64 ?? "").length * 3) / 4);
    process.stdout.write(
      `screenshot ${d.w}×${d.h} ${d.mime}, ~${bytes} bytes — use --out <f.png> to save or --json for the base64\n`,
    );
    return 0;
  }
  // Plain-text shortcut for selection unless --json/--html asked for the envelope.
  if (kind === "selection" && !flags.json) {
    process.stdout.write((flags.html ? body.data?.html : body.data?.text) ?? "");
    process.stdout.write("\n");
    return 0;
  }
  process.stdout.write(JSON.stringify(flags.json ? body : body.data, null, 2) + "\n");
  return 0;
}

function widgetHelp(): number {
  process.stdout.write(
    `ay widget — read an opted-in page widget's context (selection / DOM)\n\n` +
      `Usage:\n` +
      `  ay widget ls [--json]\n` +
      `  ay widget read selection <viewer> [--text|--html|--json]\n` +
      `  ay widget read dom <viewer> --selector <css> [--all] [--json]\n` +
      `  ay widget read screenshot <viewer> [--viewport|--selector <css>|--selection] [--out f.png] [--json]\n\n` +
      `  <viewer> = an id, or a url/title substring (see \`ay widget ls\`).\n` +
      `  Common flags: --base <daemon-url>  --token <tok>  (default: the local daemon).\n` +
      `  The page must embed \`new AyWidget({sensors:[...]}).start()\` and the token must\n` +
      `  carry the 'read' cap (ay mint <viewer> --caps read) — or use the master token.\n`,
  );
  return 0;
}

export async function cmdWidget(args: string[]): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "ls":
    case "list":
      return cmdWidgetLs(rest);
    case "read":
      return cmdWidgetRead(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return widgetHelp();
    default:
      process.stderr.write(`ay widget: unknown subcommand "${sub}"\n\n`);
      widgetHelp();
      return 1;
  }
}

// ── `ay mint` — the general scoped-token minter (ay term mint is an alias) ────
function parseTtlSec(s: string): number {
  const m = /^(\d+)(s|m|h)?$/.exec(s.trim());
  if (!m) throw new Error(`bad --ttl "${s}" (use e.g. 900, 30s, 15m, 2h)`);
  const mult = m[2] === "h" ? 3600 : m[2] === "m" ? 60 : 1;
  return Number(m[1]) * mult;
}

const KNOWN_CAPS = new Set(["tail", "size", "send", "resize", "read", "screenshot"]);

export async function cmdMint(args: string[]): Promise<number> {
  const { flags, positional } = parseFlags(args, {
    caps: "value",
    ttl: "value",
    json: "bool",
  });
  const target = positional[0];
  if (!target || positional.length > 1)
    throw new Error("usage: ay mint <pid|viewer|url|*> --caps tail,send,read,screenshot [--ttl 15m] [--json]");
  if (typeof flags.caps !== "string")
    throw new Error("--caps is required, e.g. --caps read  or  --caps tail,send");
  const caps = flags.caps.split(",").map((c) => c.trim()).filter(Boolean);
  const bad = caps.filter((c) => !KNOWN_CAPS.has(c));
  if (bad.length) throw new Error(`unknown cap(s): ${bad.join(", ")} (valid: ${[...KNOWN_CAPS].join(", ")})`);
  const ttlSec = parseTtlSec(typeof flags.ttl === "string" ? flags.ttl : "15m");
  const { mintScopedTermToken } = await import("./serve.ts");
  const r = await mintScopedTermToken(target, { ttlSec, caps });
  if (flags.json === true) {
    process.stdout.write(JSON.stringify(r) + "\n");
    return 0;
  }
  process.stdout.write(r.token + "\n");
  process.stderr.write(
    `\n  Scoped token for ${r.sub === "*" ? "ANY subject" : r.sub}, caps [${r.caps.join(", ")}], ` +
      `expires ${new Date(r.exp * 1000).toISOString()}.\n` +
      `  It grants ONLY those caps for that subject — safe to embed in a page (not the master token).\n`,
  );
  return 0;
}
