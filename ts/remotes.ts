import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import path from "path";
import yaml from "yaml";

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
 * Resolve a spec to connection details.
 * Accepts:
 *   token@host:port[:keyword]   — direct
 *   alias[:keyword]             — looked up in ~/.agent-yes/remotes.yaml
 * Returns null if the spec doesn't match any remote.
 */
export async function resolveRemoteSpec(spec: string): Promise<ResolvedRemote | null> {
  // Inline WebRTC share link: `ay ls webrtc://…` or `ay ls https://…/w/#room:token`.
  // These carry their own secret and have no keyword (use an alias to add one).
  const { isWebrtcSpec } = await import("./webrtcRemote.ts");
  if (isWebrtcSpec(spec)) return resolveWebrtc(spec, undefined);

  const direct = parseDirectRemoteSpec(spec);
  if (direct) {
    return { url: direct.baseUrl, token: direct.token, keyword: direct.keyword };
  }

  // alias[:keyword]
  const colonIdx = spec.indexOf(":");
  const alias = colonIdx >= 0 ? spec.slice(0, colonIdx) : spec;
  const keyword = colonIdx >= 0 ? spec.slice(colonIdx + 1) || undefined : undefined;

  const remotes = await readRemotes();
  const cfg = remotes.get(alias);
  if (!cfg) return null;
  // A saved alias may point at a WebRTC link; bridge it just like an inline one.
  if (isWebrtcSpec(cfg.url)) return resolveWebrtc(cfg.url, keyword);
  return { url: cfg.url, token: cfg.token, keyword };
}

/**
 * Start a local HTTP↔WebRTC bridge for a share link and present it as an
 * ordinary http remote, so every fetch-based remote command works unchanged.
 * The bridge lives for the rest of the process (torn down on `process.exit`).
 */
async function resolveWebrtc(link: string, keyword?: string): Promise<ResolvedRemote> {
  const { startWebrtcBridge } = await import("./webrtcRemote.ts");
  const bridge = await startWebrtcBridge(link);
  return { url: bridge.baseUrl, token: bridge.token, keyword };
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
    const { isWebrtcSpec } = await import("./webrtcRemote.ts");
    if (isWebrtcSpec(rawUrl)) {
      await writeRemoteAlias(alias, { url: rawUrl, token: "" });
      process.stdout.write(`remote '${alias}' added → ${rawUrl} (webrtc)\n`);
      process.stderr.write(`\n  ay ls ${alias}            # list agents on ${alias}\n`);
      return 0;
    }
    let url: string, token: string;
    try {
      const parsed = new URL(rawUrl);
      token = parsed.username;
      parsed.username = "";
      parsed.password = "";
      url = parsed.toString().replace(/\/$/, "");
    } catch {
      process.stderr.write(`ay remote add: invalid URL '${rawUrl}'\n`);
      return 1;
    }
    if (!token) {
      process.stderr.write(
        `ay remote add: no token in URL — expected http://<token>@<host>:<port>\n`,
      );
      return 1;
    }
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
