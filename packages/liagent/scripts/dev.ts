// Live preview server: every request for liagent.js rebuilds src/browser.ts,
// so a page that dynamic-imports it always gets the working tree. It also
// runs the real ChatHub (src/hub.ts) on Bun's WebSockets with in-memory
// storage, so the box, connectHub() and the CLI can be tried end to end.
//
//   bun run dev                     # http://127.0.0.1:8861/liagent/
//   PORT=… BASE=/liagent EVAL=1 bun run dev
//
//   GET <BASE>/liagent.js        the bundle (CORS open, no-store), for import()
//   GET <BASE>/                  demo/index.html: the box with a fake agent
//   GET <BASE>/?hub              the same box on the dev hub (connectHub)
//   GET <BASE>/react.html        examples/react (HubChat → LiagentChat) on the dev hub
//   GET <BASE>/examples/<fw>/    examples/{html,vue,svelte,angular,solid,preact}: a fake
//                                agent, or the dev hub with ?hub
//   WS  <BASE>/api/chat          the hub's page socket; every page is the owner
//                                (?as=<userId> makes it that friend's)
//   WS  <BASE>/api/chat/control  the hub's agent socket (liagent pair/listen/say)

import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { ChatHub, TOKEN_HEADER, type Identity, type Socket, type Storage } from "../src/hub.ts";

const PORT = Number(process.env.PORT ?? 8861);
const BASE = (process.env.BASE ?? "/liagent").replace(/\/+$/, "");
const root = join(import.meta.dir, "..");
const cors = { "access-control-allow-origin": "*", "cache-control": "no-store" };

async function bundle(entry = "src/browser.ts"): Promise<Response> {
  const out = await Bun.build({
    entrypoints: [join(root, entry)],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    target: "browser",
    format: "esm",
  });
  if (!out.success)
    return new Response(out.logs.map(String).join("\n"), { status: 500, headers: cors });
  return new Response(await out.outputs[0]!.text(), {
    headers: { ...cors, "content-type": "text/javascript; charset=utf-8" },
  });
}

// ---- the dev hub ---------------------------------------------------------------

type Data = {
  role: "page" | "control";
  url: string;
  token: string | null;
  who?: Identity;
  att: unknown;
  sock?: Socket;
};
const store = new Map<string, unknown>();
const storage: Storage = {
  get: async <T>(k: string) => structuredClone(store.get(k)) as T | undefined,
  put: async (k, v) => void store.set(k, structuredClone(v)),
  delete: async (k) => store.delete(k),
  list: async <T>({
    prefix,
    reverse,
    limit,
  }: {
    prefix: string;
    reverse?: boolean;
    limit?: number;
  }) => {
    let keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
    if (reverse) keys.reverse();
    if (limit !== undefined) keys = keys.slice(0, limit);
    return new Map(keys.map((k) => [k, structuredClone(store.get(k)) as T]));
  },
};
const open = new Set<ServerWebSocket<Data>>();
const asSocket = (ws: ServerWebSocket<Data>): Socket =>
  (ws.data.sock ??= {
    send: (d) => void ws.send(d),
    close: (code, reason) => ws.close(code, reason),
    get readyState() {
      return ws.readyState;
    },
    serializeAttachment: (v) => void (ws.data.att = structuredClone(v)),
    deserializeAttachment: () => ws.data.att,
  });
const hub = new ChatHub(
  {
    acceptWebSocket: () => {},
    getWebSockets: () => [...open].map(asSocket),
    storage,
  },
  undefined,
  Date.now,
  { eval: process.env.EVAL === "1" },
);

Bun.serve<Data>({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === `${BASE}/api/chat` || path === `${BASE}/api/chat/control`) {
      const control = path.endsWith("/control");
      if (control && req.headers.get("origin")) return new Response("forbidden", { status: 403 });
      const as = url.searchParams.get("as");
      const who: Identity = as
        ? { userId: as, email: `${as}@example.com`, owner: false }
        : { userId: "owner", email: "", owner: true };
      const ok = server.upgrade(req, {
        data: {
          role: control ? "control" : "page",
          url: req.url,
          token: req.headers.get(TOKEN_HEADER),
          who,
          att: null,
        },
      });
      return ok ? undefined : new Response("WebSocket only", { status: 426 });
    }
    if (path === `${BASE}/liagent.js`) return bundle();
    if (path === `${BASE}/react.js`) return bundle("demo/react.tsx");
    // examples/<framework>/index.html, which import ../../liagent.js (above).
    const ex = path.match(new RegExp(`^${BASE}/examples/([a-z-]+)/?(index\\.html)?$`));
    if (ex)
      return new Response(Bun.file(join(root, "examples", ex[1]!, "index.html")), {
        headers: { ...cors, "content-type": "text/html; charset=utf-8" },
      });
    if (path === `${BASE}/react.html`)
      return new Response(Bun.file(join(root, "demo/react.html")), {
        headers: { ...cors, "content-type": "text/html; charset=utf-8" },
      });
    if (path === BASE || path === `${BASE}/` || path === `${BASE}/index.html`)
      return new Response(Bun.file(join(root, "demo/index.html")), {
        headers: { ...cors, "content-type": "text/html; charset=utf-8" },
      });
    return new Response("not found", { status: 404, headers: cors });
  },
  websocket: {
    async open(ws) {
      open.add(ws);
      const s = asSocket(ws);
      const url = new URL(ws.data.url);
      if (ws.data.role === "control") await hub.connectController(s, url, ws.data.token);
      else await hub.connectPage(s, url, ws.data.who);
    },
    message: (ws, raw) => hub.webSocketMessage(asSocket(ws), String(raw)),
    close(ws, code) {
      open.delete(ws);
      hub.webSocketClose(asSocket(ws), code);
    },
  },
});
console.error(`liagent dev: http://127.0.0.1:${PORT}${BASE}/  (hub: ${BASE}/api/chat)`);
