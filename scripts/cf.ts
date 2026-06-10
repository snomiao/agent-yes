#!/usr/bin/env bun
// Thin wrapper that runs `wrangler` against the SNOLAB Cloudflare account using
// the API token saved in .env.local — so we never depend on `wrangler login`
// state (which points at a different account) and never pass the token on the
// CLI. Usage:  bun scripts/cf.ts <wrangler args...>
//   e.g.  bun scripts/cf.ts whoami
//         bun scripts/cf.ts pages deploy ./dist --project-name agent-yes
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// SNOLAB account — agent-yes.com lives here. Account id is not a secret.
const SNOLAB_ACCOUNT_ID = "0beef4cd2d2da6befa47d8d149d6e157";

const root = path.join(import.meta.dir, "..");
const env: Record<string, string | undefined> = { ...process.env };

// Load .env.local (bun also auto-loads it, but be explicit so this works from
// any cwd and is obvious to a reader).
try {
  for (const line of readFileSync(path.join(root, ".env.local"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in env)) env[m[1]] = m[2];
  }
} catch {
  /* no .env.local — fall through to the check below */
}

if (!env.CLOUDFLARE_API_TOKEN) {
  console.error("CLOUDFLARE_API_TOKEN is missing — add it to .env.local (see scripts/cf.ts).");
  process.exit(1);
}
env.CLOUDFLARE_ACCOUNT_ID = SNOLAB_ACCOUNT_ID;

// wrangler otherwise prefers a stored OAuth login over CLOUDFLARE_API_TOKEN and
// pins the OAuth account (Axon), ignoring CLOUDFLARE_ACCOUNT_ID. Two sources to
// neutralise: the global OAuth config (~/.wrangler) and a project-level account
// cache (.wrangler/wrangler-account.json) that pins whatever account first
// deployed. Drop the cache, move the OAuth config aside for the run, restore it.
rmSync(path.join(root, ".wrangler/wrangler-account.json"), { force: true });
const oauthCfg = path.join(homedir(), ".wrangler/config/default.toml");
const oauthBak = oauthCfg + ".cf-bak";
const hadOauth = existsSync(oauthCfg);
if (hadOauth) renameSync(oauthCfg, oauthBak);
try {
  const r = spawnSync("bunx", ["wrangler", ...process.argv.slice(2)], { stdio: "inherit", env });
  process.exitCode = r.status ?? 1;
} finally {
  if (hadOauth && existsSync(oauthBak)) renameSync(oauthBak, oauthCfg);
}
