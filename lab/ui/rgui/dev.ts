#!/usr/bin/env bun
// Local dev server for the /rgui page — serves the built bundle same-origin with
// a token-injecting /api proxy, so the page hits REAL live agent data from a
// local `ay serve --http`.
//
//   1. run the API daemon:   ay serve --http --port 7432
//   2. run this:             bun run dev:rgui      (→ http://localhost:7788)
//
// It rebuilds the bundle on start (scripts/build-rgui.ts), so editing
// lab/ui/rgui/main.ts (or the rgui submodule / local worktree) + refresh shows
// changes. Pass --watch to rebuild on every request (cheap; Bun.build is fast).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { $ } from "bun";

const root = path.join(import.meta.dir, "..", "..", ".."); // repo root
const dist = path.join(import.meta.dir, "dist");
const PORT = Number(process.env.RGUI_PORT ?? 7788);
const AY_API = process.env.AY_API ?? "http://127.0.0.1:7432";
const TOKEN = readFileSync(path.join(homedir(), ".agent-yes", ".serve-token"), "utf-8").trim();
const watch = process.argv.includes("--watch");

async function build() {
  await $`bun ${path.join(root, "scripts/build-rgui.ts")}`.cwd(root).quiet();
}
await build();

Bun.serve({
  port: PORT,
  idleTimeout: 0, // never time out SSE
  async fetch(req) {
    const url = new URL(req.url);

    // token-injecting proxy → the local ay serve --http daemon (same-origin, so
    // the browser needs no token and hits no CORS wall).
    if (url.pathname.startsWith("/api/")) {
      const upstream = AY_API + url.pathname + url.search;
      return fetch(upstream, {
        method: req.method,
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.text(),
        // @ts-expect-error Bun streaming passthrough
        signal: req.signal,
      }).catch((e) => new Response(`upstream unreachable: ${e}`, { status: 502 }));
    }

    if (watch) await build();
    const p = url.pathname === "/" ? "/index.html" : url.pathname;
    return new Response(Bun.file(path.join(dist, p)));
  },
});

console.log(`rgui dev  →  http://localhost:${PORT}   (proxying ${AY_API})`);
console.log(watch ? "  --watch: rebuilding bundle on every request" : "  restart to rebuild (or pass --watch)");
