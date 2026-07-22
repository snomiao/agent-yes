// `ay callback` — mint/list/revoke embeddable send-only capabilities.
//
//   ay callback --expires 7d [--agent <kw>] [--base <url>] [--title <t>]
//   ay callback ls
//   ay callback revoke <id>
//
// Minting prints a self-contained HTML snippet (see callbackCore.buildSnippet)
// that a report page can embed so readers message the target agent through
// the daemon's public POST /cb/<cap> route. `--expires` is REQUIRED — no
// default, no "never": a capability pasted into a public page must carry a
// deliberate lifetime. The signed token is self-expiring; callbacks.json here
// only adds bookkeeping (ls) and the revoke kill-switch.

import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { agentYesHome } from "./agentYesHome.ts";
import { mintCapability, parseExpires } from "./callbackCore.ts";
import { resolveOne } from "./subcommands.ts";

export interface CallbackRecord {
  id: string;
  /** Target agent_id. */
  agent: string;
  /** Human label captured at mint time (cli + pid + cwd) — agents die, ls
   *  should still say what the capability pointed at. */
  label: string;
  exp: number;
  createdAt: number;
  /** Set by `ay callback revoke` — the public route rejects the cap with 410
   *  even though its signature/expiry are still valid. */
  revokedAt?: number;
}

function callbacksPath(): string {
  return path.join(agentYesHome(), "callbacks.json");
}

function secretPath(): string {
  return path.join(agentYesHome(), ".callback-secret");
}

/** Load the HMAC secret, minting it on first use (0600, like .serve-token).
 *  Separate from the serve token so rotating one never invalidates the other. */
export async function loadOrCreateCallbackSecret(): Promise<string> {
  try {
    return (await readFile(secretPath(), "utf-8")).trim();
  } catch {
    const secret = randomBytes(32).toString("hex");
    await mkdir(agentYesHome(), { recursive: true });
    await writeFile(secretPath(), secret, { mode: 0o600 });
    return secret;
  }
}

/** Read the secret without creating one — the daemon's public route must not
 *  mint state as a side effect of an unauthenticated request. */
export function loadCallbackSecretReadOnly(): string | null {
  try {
    return readFileSync(secretPath(), "utf-8").trim();
  } catch {
    return null;
  }
}

function loadStore(): Record<string, CallbackRecord> {
  try {
    return JSON.parse(readFileSync(callbacksPath(), "utf8"));
  } catch {
    return {};
  }
}

// Same atomic-rename pattern as exposures.json (expose.ts): tmp + chmod + rename.
function saveStore(all: Record<string, CallbackRecord>): void {
  const file = callbacksPath();
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n");
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** Revocation check for the public route. Missing store = not revoked (the
 *  token is self-contained; losing bookkeeping must not resurrect revokes we
 *  no longer know about, but it also must not brick every outstanding cap). */
export function isCallbackRevoked(id: string): boolean {
  const rec = loadStore()[id];
  return !!rec?.revokedAt;
}

function fmtRemaining(exp: number, now: number): string {
  const ms = exp - now;
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60_000))}m left`;
  if (h < 48) return `${h}h left`;
  return `${Math.floor(h / 24)}d left`;
}

function takeFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const [, v] = args.splice(i, 2);
  return v;
}

async function resolveBase(flag: string | undefined): Promise<string> {
  if (flag) return flag;
  if (process.env.AGENT_YES_CALLBACK_BASE) return process.env.AGENT_YES_CALLBACK_BASE;
  // Fall back to the installed daemon's local console URL (portless or port).
  try {
    const { resolveLocalServeUrl } = await import("./serve.ts");
    const url = await resolveLocalServeUrl();
    if (url) return url;
  } catch {
    /* serve helpers unavailable — fall through to the error below */
  }
  throw new Error(
    "cannot determine the daemon base URL — pass --base <url> " +
      "(e.g. --base https://x123.agent-yes.com for an exposed daemon)",
  );
}

export async function cmdCallback(rest: string[]): Promise<number> {
  const args = [...rest];
  const sub = args[0];
  const w = (s = "") => process.stdout.write(s + "\n");

  if (sub === "ls" || sub === "list") {
    const all = Object.values(loadStore()).sort((a, b) => b.createdAt - a.createdAt);
    if (all.length === 0) {
      w("no callbacks minted — create one with: ay callback --expires 7d");
      return 0;
    }
    const now = Date.now();
    for (const r of all) {
      const state = r.revokedAt ? "revoked" : fmtRemaining(r.exp, now);
      w(`${r.id}  ${state.padEnd(10)}  → ${r.label}`);
    }
    return 0;
  }

  if (sub === "revoke") {
    const id = args[1];
    if (!id) {
      process.stderr.write("usage: ay callback revoke <id>   (ids: ay callback ls)\n");
      return 1;
    }
    const all = loadStore();
    const rec = all[id];
    if (!rec) {
      process.stderr.write(`no callback "${id}" — see: ay callback ls\n`);
      return 1;
    }
    if (!rec.revokedAt) {
      rec.revokedAt = Date.now();
      saveStore(all);
    }
    w(`revoked ${id} (was → ${rec.label})`);
    return 0;
  }

  if (sub === "help" || sub === "--help" || sub === "-h") {
    w("ay callback --expires <n>m|h|d|w [--agent <kw>] [--base <url>] [--title <t>]");
    w("            mint a send-only embed capability for one agent (expiry REQUIRED)");
    w("ay callback ls              list minted callbacks and remaining lifetime");
    w("ay callback revoke <id>     kill an outstanding capability immediately");
    return 0;
  }

  // Default action: mint.
  const expiresSpec = takeFlag(args, "--expires");
  if (!expiresSpec) {
    process.stderr.write(
      "ay callback: --expires is required (e.g. --expires 7d) — " +
        "an embed capability must carry an explicit lifetime\n",
    );
    return 1;
  }
  let ttlMs: number;
  try {
    ttlMs = parseExpires(expiresSpec);
  } catch (e) {
    process.stderr.write(`ay callback: ${(e as Error).message}\n`);
    return 1;
  }

  const agentKw = takeFlag(args, "--agent");
  const baseFlag = takeFlag(args, "--base");
  const title = takeFlag(args, "--title");

  // Target: --agent keyword, else the calling agent itself (AGENT_YES_PID is
  // stamped on every ay-wrapped agent's environment).
  const keyword = agentKw ?? process.env.AGENT_YES_PID;
  if (!keyword) {
    process.stderr.write(
      "ay callback: not inside an ay agent — pass --agent <pid|keyword> to pick the target\n",
    );
    return 1;
  }
  const record = await resolveOne(keyword, {
    all: false,
    active: true,
    cwdScope: null,
    latest: false,
    json: false,
  });
  if (!record.agent_id) {
    process.stderr.write(`ay callback: agent pid ${record.pid} has no agent_id — cannot scope\n`);
    return 1;
  }

  const base = await resolveBase(baseFlag);
  const secret = await loadOrCreateCallbackSecret();
  const id = randomBytes(4).toString("hex");
  const exp = Date.now() + ttlMs;
  const cap = mintCapability(secret, { id, agent: record.agent_id, exp });

  const all = loadStore();
  all[id] = {
    id,
    agent: record.agent_id,
    label: `${record.cli} #${record.pid} @ ${record.cwd}`,
    exp,
    createdAt: Date.now(),
  };
  saveStore(all);

  const { buildSnippet } = await import("./callbackCore.ts");
  w(`callback ${id} → ${record.cli} #${record.pid} @ ${record.cwd}`);
  w(`expires:  ${new Date(exp).toISOString()}  (${expiresSpec})`);
  w(`endpoint: ${base.replace(/\/+$/, "")}/cb/${cap}`);
  w(`revoke:   ay callback revoke ${id}`);
  w("");
  w("── embed snippet ──────────────────────────────────────────────");
  w(buildSnippet({ base, cap, title }));
  return 0;
}
