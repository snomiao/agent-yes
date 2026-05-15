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
  return { url: cfg.url, token: cfg.token, keyword };
}

// ---------------------------------------------------------------------------
// ay remote subcommand
// ---------------------------------------------------------------------------

export async function cmdRemote(rest: string[]): Promise<number> {
  const sub = rest[0];

  if (!sub || sub === "ls" || sub === "list") {
    const remotes = await readRemotes();
    if (remotes.size === 0) {
      process.stdout.write("no remotes configured\n");
      process.stderr.write(
        "\n" +
          "  ay remote add <alias> <url> <token>   # add a remote\n" +
          "  ay serve                               # start server (prints token)\n",
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
    const [, alias, url, token] = rest;
    if (!alias || !url || !token) {
      process.stderr.write("usage: ay remote add <alias> <url> <token>\n");
      process.stderr.write(
        "  example: ay remote add work-mac http://192.168.1.5:7432 mytoken123\n",
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
    "  ay remote ls                           # list configured remotes\n" +
      "  ay remote add <alias> <url> <token>   # add a remote\n" +
      "  ay remote rm <alias>                   # remove a remote\n",
  );
  return 1;
}
