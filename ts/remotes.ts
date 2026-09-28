import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import path from "path";
import yaml from "yaml";
import { isWebrtcSpec, parseWebrtcLink } from "./webrtcLink.ts";

function remotesPath(): string {
  const dir = process.env.AGENT_YES_HOME ?? path.join(homedir(), ".agent-yes");
  return path.join(dir, "remotes.yaml");
}

export interface RemoteConfig {
  url: string; // e.g. "http://192.168.1.5:7432"
  token: string;
}

export interface ResolvedRemote {
  url: string;
  token: string;
  keyword?: string;
  /** Stable, human-readable name for display — never the loopback bridge URL. */
  label: string;
}

/** A display label for a WebRTC share link: the room id, never the local bridge. */
function webrtcLabel(link: string): string {
  const parsed = parseWebrtcLink(link);
  return parsed ? `webrtc:${parsed.room}` : "webrtc";
}

export async function readRemotes(): Promise<Map<string, RemoteConfig>> {
  let raw: string;
  try {
    raw = await readFile(remotesPath(), "utf-8");
  } catch {
    return new Map();
  }
  const doc = yaml.parse(raw) ?? {};
  const remotes = doc.remotes ?? {};
  const map = new Map<string, RemoteConfig>();
  for (const [alias, cfg] of Object.entries(remotes)) {
    if (cfg && typeof (cfg as any).url === "string" && typeof (cfg as any).token === "string") {
      map.set(alias, { url: (cfg as any).url, token: (cfg as any).token });
    }
  }
  return map;
}

export async function writeRemoteAlias(alias: string, config: RemoteConfig): Promise<void> {
  const remotes = await readRemotes();
  remotes.set(alias, config);
  const doc: Record<string, any> = {};
  for (const [k, v] of remotes) doc[k] = v;
  await mkdir(path.dirname(remotesPath()), { recursive: true });
  await writeFile(remotesPath(), yaml.stringify({ remotes: doc }));
}

export async function deleteRemoteAlias(alias: string): Promise<void> {
  const remotes = await readRemotes();
  remotes.delete(alias);
  const doc: Record<string, any> = {};
  for (const [k, v] of remotes) doc[k] = v;
  await writeFile(remotesPath(), yaml.stringify({ remotes: doc }));
}

/** Parse token@host:port[:keyword] — the `@` is a hard signal this is remote. */
export function parseDirectRemoteSpec(
  spec: string,
): { token: string; host: string; port: number; keyword?: string; baseUrl: string } | null {
  const m = /^([^@]+)@([^:@]+):(\d+)(?::(.+))?$/.exec(spec);
  if (!m) return null;
  const host = m[2]!;
  const port = parseInt(m[3]!, 10);
  return {
    token: m[1]!,
    host,
    port,
    keyword: m[4] || undefined,
    baseUrl: `http://${host}:${port}`,
  };
}

/**
 * Parse an http(s) share URL into {url, token}. This is the ONE link `ay share`
 * hands out for both the web console and the CLI:
 *   https://host.ts.net/ay/#k=<token>     console link (token in the fragment)
 *   http://<token>@192.168.1.5:7432       legacy userinfo form (`ay remote add`)
 * The base keeps any path prefix (a reverse proxy mount like /ay), minus a
 * trailing slash / index.html. Null when there's no token or it isn't http(s).
 *
 * Never throws: every http(s) spec reaches here through resolveRemoteSpec, so a
 * malformed one must come back as "not a share URL", not as an exception.
 */
function decodeMaybe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // not valid percent-encoding — take it literally
  }
}

export function parseShareUrl(spec: string): { url: string; token: string } | null {
  if (!/^https?:\/\//i.test(spec)) return null;
  let u: URL;
  try {
    u = new URL(spec);
  } catch {
    return null;
  }
  const hash = new URLSearchParams(u.hash.replace(/^#/, ""));
  // URLSearchParams decodes `#k=` leniently; match that for the userinfo form.
  // `decodeURIComponent` alone THREW a URIError on a stray percent
  // (`http://100%@host/`), which surfaced as a crash from `ay ls <url>`.
  const token = hash.get("k") || decodeMaybe(u.username);
  if (!token) return null;
  u.username = "";
  u.password = "";
  u.hash = "";
  u.search = "";
  u.pathname = u.pathname.replace(/\/index\.html$/, "/").replace(/\/+$/, "");
  return { url: u.toString().replace(/\/+$/, ""), token };
}

/**
 * Resolve a spec to connection details.
 * Accepts:
 *   token@host:port[:keyword]   — direct
 *   alias[:keyword]             — looked up in ~/.agent-yes/remotes.yaml
 * Returns null if the spec doesn't match any remote.
 */
export async function resolveRemoteSpec(spec: string): Promise<ResolvedRemote | null> {
  // Inline WebRTC share link: `ay ls webrtc://…` or `ay ls https://…/w/#room:token`.
  // These carry their own secret and have no keyword (use an alias to add one).
  if (isWebrtcSpec(spec)) return resolveWebrtc(spec, undefined, webrtcLabel(spec));

  // Inline http(s) share URL: `ay ls 'https://host.ts.net/ay/#k=<token>'`.
  const shared = parseShareUrl(spec);
  if (shared) return { ...shared, label: new URL(shared.url).host };

  const direct = parseDirectRemoteSpec(spec);
  if (direct) {
    return {
      url: direct.baseUrl,
      token: direct.token,
      keyword: direct.keyword,
      label: `${direct.host}:${direct.port}`,
    };
  }

  // alias[:keyword]
  const colonIdx = spec.indexOf(":");
  const alias = colonIdx >= 0 ? spec.slice(0, colonIdx) : spec;
  const keyword = colonIdx >= 0 ? spec.slice(colonIdx + 1) || undefined : undefined;

  const remotes = await readRemotes();
  const cfg = remotes.get(alias);
  if (!cfg) return null;
  // A saved alias may point at a WebRTC link; bridge it just like an inline one.
  if (isWebrtcSpec(cfg.url)) return resolveWebrtc(cfg.url, keyword, alias);
  return { url: cfg.url, token: cfg.token, keyword, label: alias };
}

/**
 * Start a local HTTP↔WebRTC bridge for a share link and present it as an
 * ordinary http remote, so every fetch-based remote command works unchanged.
 * The bridge lives for the rest of the process (torn down on `process.exit`).
 */
async function resolveWebrtc(
  link: string,
  keyword: string | undefined,
  label: string,
): Promise<ResolvedRemote> {
  const { startWebrtcBridge } = await import("./webrtcRemote.ts");
  const bridge = await startWebrtcBridge(link);
  return { url: bridge.baseUrl, token: bridge.token, keyword, label };
}

// ---------------------------------------------------------------------------
// ay remote subcommand
// ---------------------------------------------------------------------------

export async function cmdRemote(rest: string[]): Promise<number> {
  const sub = rest[0];

  if (sub === "-h" || sub === "--help") {
    process.stdout.write(
      `Usage: ay remote <subcommand>\n\n` +
        `Manage saved remote server aliases.\n\n` +
        `Subcommands:\n` +
        `  ay remote ls                                           list configured remotes\n` +
        `  ay remote add <alias> http://<token>@<host>:<port>    add an http remote\n` +
        `  ay remote add <alias> webrtc://<room>:<token>@<host>  add a WebRTC share remote\n` +
        `  ay remote add <alias> https://agent-yes.com/w/#<room>:<token>   (share link form)\n` +
        `  ay remote add <alias> https://<host>/ay/#k=<token>     (an \`ay share\` URL)\n` +
        `  ay remote rm <alias>                                   remove a remote\n\n` +
        `Once added, use the alias anywhere a keyword is accepted:\n` +
        `  ay ls   <alias>\n` +
        `  ay tail <alias>:<keyword>\n` +
        `  ay send <alias>:<keyword> "message"\n`,
    );
    return 0;
  }

  if (!sub || sub === "ls" || sub === "list") {
    const remotes = await readRemotes();
    if (remotes.size === 0) {
      process.stdout.write("no remotes configured\n");
      process.stderr.write(
        "\n" +
          "  ay remote add <alias> http://<token>@<host>:<port>   # add a remote\n" +
          "  ay serve                                           # start server (prints token)\n",
      );
      return 0;
    }
    for (const [alias, cfg] of remotes) {
      const preview = cfg.token.length > 8 ? cfg.token.slice(0, 8) + "..." : cfg.token;
      process.stdout.write(`${alias}\t${cfg.url}\ttoken:${preview}\n`);
    }
    return 0;
  }

  if (sub === "add") {
    const [, alias, rawUrl] = rest;
    if (!alias || !rawUrl) {
      process.stderr.write("usage: ay remote add <alias> http://<token>@<host>:<port>\n");
      process.stderr.write(
        "  example: ay remote add work-mac http://mytoken123@192.168.1.5:7432\n",
      );
      return 1;
    }
    // WebRTC share links carry their own secret — store verbatim (token in the link).
    if (isWebrtcSpec(rawUrl)) {
      await writeRemoteAlias(alias, { url: rawUrl, token: "" });
      process.stdout.write(`remote '${alias}' added → ${rawUrl} (webrtc)\n`);
      process.stderr.write(`\n  ay ls ${alias}            # list agents on ${alias}\n`);
      return 0;
    }
    const parsed = parseShareUrl(rawUrl);
    if (!parsed) {
      process.stderr.write(
        `ay remote add: no token in '${rawUrl}' — expected http://<token>@<host>:<port>\n` +
          `  or a share URL like https://<host>/ay/#k=<token> (from \`ay share\`)\n`,
      );
      return 1;
    }
    const { url, token } = parsed;
    await writeRemoteAlias(alias, { url, token });
    process.stdout.write(`remote '${alias}' added → ${url}\n`);
    process.stderr.write(`\n  ay ls ${alias}            # list agents on ${alias}\n`);
    return 0;
  }

  if (sub === "rm" || sub === "remove" || sub === "delete") {
    const alias = rest[1];
    if (!alias) {
      process.stderr.write("usage: ay remote rm <alias>\n");
      return 1;
    }
    const remotes = await readRemotes();
    if (!remotes.has(alias)) {
      process.stderr.write(`remote '${alias}' not found\n`);
      return 1;
    }
    await deleteRemoteAlias(alias);
    process.stdout.write(`remote '${alias}' removed\n`);
    return 0;
  }

  process.stderr.write(`ay remote: unknown subcommand '${sub}'\n`);
  process.stderr.write(
    "  ay remote ls                                           # list configured remotes\n" +
      "  ay remote add <alias> http://<token>@<host>:<port>   # add a remote\n" +
      "  ay remote rm <alias>                                  # remove a remote\n",
  );
  return 1;
}

/**
 * Default alias for a share URL: the machine's short name. Call only on a link
 * that already parsed (a webrtc link or `parseShareUrl` hit) — it assumes a
 * valid URL and throws otherwise.
 */
export function defaultConnectAlias(link: string): string {
  const w = parseWebrtcLink(link);
  if (w) return `webrtc-${w.room.slice(0, 8)}`;
  const host = new URL(link).hostname;
  // box.tailnet.ts.net → box; 192.168.1.5 → 192-168-1-5
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host.replace(/[.:]/g, "-");
  return host.split(".")[0] || host;
}

// ay connect <share-url> [alias] — the CLI half of `ay share`: the same URL that
// opens the web console is saved as a remote alias here (after a reachability
// check), so `ay ls <alias>` / `ay tail <alias>:<kw>` work from this machine.
export async function cmdConnect(rest: string[]): Promise<number> {
  const positional = rest.filter((a) => !a.startsWith("-"));
  const [link, aliasArg] = positional;
  if (!link || rest.includes("-h") || rest.includes("--help")) {
    process.stdout.write(
      `Usage: ay connect <share-url> [alias]\n\n` +
        `Save another machine's \`ay share\` URL as a remote, so this CLI can drive it.\n` +
        `The same URL opens that machine's web console in a browser.\n\n` +
        `  ay connect 'https://box.tailnet.ts.net/ay/#k=<token>'      # tailscale\n` +
        `  ay connect 'http://192.168.1.5:7432/#k=<token>'           # lan\n` +
        `  ay connect 'https://agent-yes.com/w/#<room>:<secret>' box  # webrtc\n\n` +
        `alias defaults to the host's short name. Then:\n` +
        `  ay ls <alias>        ay tail <alias>:<keyword>        ay send <alias>:<keyword> "msg"\n`,
    );
    return link ? 0 : 1;
  }
  // Recognise the link BEFORE naming it: defaultConnectAlias parses it as a URL,
  // so deriving the alias first turned a scheme-less paste
  // (`box.ts.net/ay/#k=…`) into a bare "Invalid URL" and buried the message
  // below, which is the one that explains the actual mistake.
  const webrtc = isWebrtcSpec(link);
  const parsed = webrtc ? null : parseShareUrl(link);
  if (!webrtc && !parsed) {
    process.stderr.write(
      `ay connect: not a share URL: '${link}' — expected https://<host>/ay/#k=<token>\n` +
        `  (quote it: the # starts a comment in most shells)\n`,
    );
    return 1;
  }
  const alias = aliasArg ?? defaultConnectAlias(link);

  if (!parsed) {
    await writeRemoteAlias(alias, { url: link, token: "" });
  } else {
    try {
      const r = await fetch(`${parsed.url}/api/version`, {
        headers: { Authorization: `Bearer ${parsed.token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (r.status === 401 || r.status === 403) {
        process.stderr.write(`ay connect: ${parsed.url} rejected the token (HTTP ${r.status})\n`);
        return 1;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      process.stderr.write(
        `ay connect: warning: ${parsed.url} is not reachable right now (${(e as Error).message}) — saving anyway\n`,
      );
    }
    await writeRemoteAlias(alias, parsed);
  }
  process.stdout.write(`connected '${alias}'\n`);
  process.stderr.write(
    `\n  ay ls ${alias}                  # list its agents\n` +
      `  ay tail ${alias}:<keyword>       # read one\n` +
      `  ay remote rm ${alias}            # forget it\n`,
  );
  return 0;
}
