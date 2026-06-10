#!/usr/bin/env bun
// Tiny same-origin proxy for the lab UI.
//
// `ay serve` exposes a token-gated JSON/SSE API but no HTML and no CORS.
// This server serves index.html and forwards /api/* to `ay serve`, injecting
// the Bearer token read from ~/.agent-yes/.serve-token. Same-origin => the
// browser needs no token and hits no CORS wall; SSE streams pass straight
// through because we return the upstream body untouched.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const UI_PORT = Number(process.env.UI_PORT ?? 7777);
const AY_API = process.env.AY_API ?? "http://127.0.0.1:7432";
const TOKEN = readFileSync(path.join(homedir(), ".agent-yes", ".serve-token"), "utf-8").trim();

const HTML = readFileSync(path.join(import.meta.dir, "index.html"));

Bun.serve({
  port: UI_PORT,
  idleTimeout: 0, // never time out SSE connections
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (url.pathname.startsWith("/api/")) {
      const upstream = AY_API + url.pathname + url.search;
      const res = await fetch(upstream, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          ...(req.headers.get("content-type")
            ? { "Content-Type": req.headers.get("content-type")! }
            : {}),
        },
        body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.text(),
        // @ts-expect-error Bun supports this for streaming responses
        signal: req.signal,
      }).catch((e) => new Response(`upstream unreachable: ${e}`, { status: 502 }));
      // Pass the body straight through — keeps SSE (text/event-stream) live.
      return new Response(res.body, { status: res.status, headers: res.headers });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`lab/ui  →  http://localhost:${UI_PORT}   (proxying ${AY_API})`);
