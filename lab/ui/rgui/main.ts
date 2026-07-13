/**
 * agent-yes · /rgui — render the live agent forest with @snomiao/rgui.
 *
 * Data source: the same-origin `GET /api/ls` the console uses (a local
 * `ay serve` daemon, proxied by lab/ui/server.ts). Each agent becomes an rgui
 * node; a subagent's `parent_pid === parent.wrapper_pid` becomes rgui
 * CONTAINMENT (the child renders inside the parent's frame and, zoomed out,
 * renormalizes into the parent block — semantic-zoom LOD). When no `/api` is
 * reachable (e.g. the static rgui.agent-yes.pages.dev preview), we fall back to
 * a baked sample forest so the page still demonstrates the mapping.
 *
 * rgui is imported from source (submodule lib/rgui or the local dev worktree),
 * bundled by scripts/build-rgui.ts — never the published npm package, so the
 * page tracks rgui's heavy dev directly.
 */
import createRgui, {
  annotationNode,
  federatedDemoChain,
  federatedGraphToRgui,
  isFederatedGraphEnvelope,
  nodeHeight,
  type Edge,
  type Graph,
  type GraphNode,
  type Panel,
  type PanelItem,
  type Port,
  type Rgui,
} from "@snomiao/rgui";
// Shared ay-share (rtc) remote-room transport — the SAME WebRTC + e2e wire the
// console uses (lab/ui/rtc.js, which imports lab/ui/e2e.js). Bundled in by
// scripts/build-rgui.ts. A .js module with no types → treated as any here.
// @ts-ignore — sibling JS module, no .d.ts (bundled, not type-checked)
import { RTCClient, parseRoomHash } from "../rtc.js";

// ── /api/ls record shape (subset we use; see ts/globalPidIndex.ts + serve.ts) ──
type AgentStatus = "active" | "idle" | "needs_input" | "stuck" | "exited";
interface AgentRecord {
  pid: number;
  agent_id?: string; // stable per-process id (pids are reused) — the share scope key
  cli: string;
  prompt: string | null;
  cwd: string;
  status: AgentStatus;
  started_at: number;
  last_active_at?: number;
  wrapper_pid?: number | null;
  parent_pid?: number | null;
  question?: string | null;
  title?: string | null;
  git?: { branch: string | null; dirty?: boolean } | null;
  badges?: string[];
  // stamped client-side on merge (console parity — see lab/ui/index.html):
  _src: string; // owning wire id ("local" | room name) — routes every per-agent op
  _key: string; // `<src>#<pid>` — node id AND the console's ay.sel format
}

// ── host environment (otoji environment-node adoption) ───────────────────────
// GET /api/host describes the machine the fleet runs on: identity + live health
// (loadavg/mem) + capability flags. The viewer renders it as ONE host env node
// that every top-level group wires into via `environment` edges — the worktree
// (cwd) and repo containers are the finer-grained environments nested inside it.
// A daemon too old to expose /api/host just 404s → no env node, nothing breaks.
interface HostInfo {
  host: string;
  platform: string;
  arch: string;
  cpus: number;
  loadavg: number[];
  mem: { total: number; free: number };
  uptime: number;
  caps?: Record<string, boolean>;
}
// One env node per SOURCE (machine): id "env:<src>" — with several /w/-connected
// rooms merged into one forest, each machine gets its own ⬢ node.
const envIdOf = (src: string) => `env:${src}`;
// host-env → top-level-root wires, rebuilt by buildGraph, drawn by applyEdges
const envEdges: Edge[] = [];

// Active port exposures per source (GET /api/exposes), polled with the host
// info and rendered as an "exposed" field on that machine's ⬢ env node.
interface ExposureInfo {
  id: string;
  port: number;
  url: string;
  createdAt: number;
}
const exposedBySrc = new Map<string, ExposureInfo[]>();
function hostEnvFields(src: string): [string, string][] {
  const h = wires.get(src)?.hostInfo;
  if (!h) return [];
  const recs = [...recordsByKey.values()].filter((r) => r._src === src);
  const live = recs.filter((r) => r.status !== "exited");
  const stuck = live.filter((r) => r.status === "stuck").length;
  const load1 = h.loadavg?.[0] ?? 0;
  const hot = load1 > h.cpus; // 1-min load above core count = saturated host
  const fields: [string, string][] = [["scope", "native-device"]];
  // rows below degrade gracefully for a whoami-only fallback (older daemon
  // without /api/host — identity known, health/caps unknown)
  if (h.platform) fields.push(["os", `${h.platform}/${h.arch} · ${h.cpus} cpus`]);
  // Windows reports loadavg [0,0,0] — skip the row rather than show a lie
  if (h.loadavg?.some((n) => n > 0))
    fields.push([hot ? "⚠ load" : "load", h.loadavg.map((n) => n.toFixed(1)).join(" ")]);
  if (h.mem?.total) {
    const usedPct = Math.round(((h.mem.total - h.mem.free) / h.mem.total) * 100);
    fields.push(["mem", `${usedPct}% of ${(h.mem.total / 2 ** 30).toFixed(0)}G`]);
  }
  fields.push(["agents", `${live.length} live${stuck ? ` · ⚠ ${stuck} stuck` : ""}`]);
  if (h.caps) {
    const on = Object.entries(h.caps).filter(([, v]) => v).map(([k]) => k);
    if (on.length) fields.push(["caps", on.join(" · ")]);
  }
  const exposed = exposedBySrc.get(src) ?? [];
  if (exposed.length) {
    fields.push(["⇄ exposed", exposed.map((e) => e.port).sort((a, b) => a - b).join(" · ")]);
  }
  return fields;
}

// ── data sources: EVERY room /w/ knows + local HTTP, merged ──────────────────
// /r/ and /w/ are two UIs over the SAME fleet. The console keeps a credential
// cache of every room it has connected ("ay.rooms", shared same-origin) — /r/
// connects to ALL of them in parallel (plus a hash share-link room, plus the
// same-origin HTTP daemon when reachable) and merges the records into ONE
// forest. Identity follows the console exactly: a record's key is
// `<src>#<pid>` where src is "local" or the room name — the SAME format the
// console persists in localStorage["ay.sel"], so selection round-trips
// verbatim across the /w/ ⇄ /r/ switch.
// The baked sample forest shows only when there is nothing to connect to at
// all (static preview, no cached rooms). A hash share link still eats its
// token from the URL on open (only the room mnemonic stays — /w/ parity).
const ROOMS_KEY = "ay.rooms";
function loadRooms(): Record<string, { token: string; host?: string; ts?: number }> {
  try {
    return JSON.parse(localStorage.getItem(ROOMS_KEY) || "{}");
  } catch {
    return {};
  }
}
function cachedRoom(name: string): { token: string; host: string } | null {
  try {
    const r = JSON.parse(localStorage.getItem(ROOMS_KEY) || "{}")[name];
    return r?.token ? { token: r.token, host: r.host || "s.agent-yes.com" } : null;
  } catch {
    return null;
  }
}
function saveRoom(name: string, token: string, host: string) {
  try {
    const r = JSON.parse(localStorage.getItem(ROOMS_KEY) || "{}");
    r[name] = { token, host, ts: Date.now() };
    localStorage.setItem(ROOMS_KEY, JSON.stringify(r));
  } catch {
    /* private mode / quota — the session still works, just not cached */
  }
}
function resolveRoom(hash: string): { room: string; token: string; host: string } | null {
  const p = parseRoomHash(hash) as { room: string; token: string; host: string } | null;
  if (p) {
    saveRoom(p.room, p.token, p.host);
    history.replaceState(
      null,
      document.title,
      location.pathname + location.search + "#" + p.room,
    );
    return p;
  }
  // #<room> or #<room>:<pid> — token-less forms; reconnect from the cache.
  // (parseRoomHash already rejected these: bare room, or numeric ≤7-digit id.)
  const h = decodeURIComponent(String(hash || "").replace(/^#/, ""));
  const m = /^([A-Za-z0-9_-]+)(?::\d{1,7})?$/.exec(h);
  if (m) {
    const c = cachedRoom(m[1]!);
    if (c) return { room: m[1]!, ...c };
  }
  return null;
}
const roomInfo = resolveRoom(location.hash);
// #k=<token>: same-origin HTTP auth for a serve-hosted /r page (the console's
// #k= convention) — appended to every /api call. #node=<pid>&embed: render ONLY
// that agent's live terminal, full-viewport — the federation embed leg
// (renderHints.embed): consumers iframe this page over the node rect, with the
// TUI-preview card as their LOD fallback. See rgui docs/federation.md.
// (Read AFTER resolveRoom: a share-link hash never carries k=/node= parts, and
// resolveRoom's token-eating rewrite doesn't touch these forms.)
const hashParts = location.hash.slice(1).split("&");
// #k= is cached to localStorage["ay.localToken"] — the console's own local-token
// cache — so the selection hash may replace #k= in the URL without losing auth
// (and a /w/-authorized browser authorizes /r/ for free, and vice versa).
const httpToken = (() => {
  const t = hashParts.find((s) => s.startsWith("k="))?.slice(2) ?? null;
  try {
    if (t) {
      localStorage.setItem("ay.localToken", decodeURIComponent(t));
      return decodeURIComponent(t);
    }
    return localStorage.getItem("ay.localToken");
  } catch {
    return t;
  }
})();
// canonical form #node=<pid>&embed; #embed=<pid> accepted as an alias
const embedPid =
  hashParts.find((s) => s.startsWith("node="))?.slice(5) ??
  hashParts.find((s) => s.startsWith("embed="))?.slice(6) ??
  null;
const embedMode = !!embedPid && hashParts.some((s) => s === "embed" || s.startsWith("embed="));
const withTok = (path: string) =>
  httpToken ? `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(httpToken)}` : path;

// ── wires: one transport per source, console-compatible ids ─────────────────
// "local" (same-origin HTTP) + one RTC client per known room. Mirrors the
// console's `sources` map so a record key `<src>#<pid>` means the same thing
// on both pages.
const LOCAL = "local";
interface Wire {
  id: string; // "local" | room name (== the console's source id for rtc rooms)
  kind: "http" | "rtc";
  sigHost: string; // rtc signaling host
  token: string;
  client: InstanceType<typeof RTCClient> | null;
  connected: boolean; // rtc: channel up · http: last /api/ls succeeded
  hostInfo: HostInfo | null; // per-machine GET /api/host (env node data)
}
const wires = new Map<string, Wire>();
const usingRoom = () => !!roomInfo; // a hash share link pins expectations to that room
const srcOf = (key: string) => key.slice(0, key.indexOf("#"));
const pidOf = (key: string) => key.slice(key.indexOf("#") + 1);
const wireReady = (w: Wire | undefined): w is Wire =>
  !!w && (w.kind === "http" || (!!w.client && w.connected));

// GET a JSON body over one wire (throws on any failure).
async function apiJSON<T>(path: string, src: string = LOCAL): Promise<T> {
  const w = wires.get(src);
  if (!wireReady(w)) throw new Error(`wire not connected: ${src}`);
  if (w.kind === "rtc") return JSON.parse((await w.client!.req("GET", path)).text) as T;
  const res = await fetch(withTok(path), { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(String(res.status));
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("json")) throw new Error("not json"); // static host served HTML
  return res.json() as Promise<T>;
}

// POST a JSON body over one wire (never throws; returns {ok,text}).
async function apiPost(
  path: string,
  body: unknown,
  src: string = LOCAL,
): Promise<{ ok: boolean; text: string }> {
  const w = wires.get(src);
  if (!wireReady(w)) return { ok: false, text: `wire not connected: ${src}` };
  if (w.kind === "rtc") {
    const r = await w.client!.req("POST", path, JSON.stringify(body));
    return { ok: r.status >= 200 && r.status < 300, text: r.text };
  }
  const r = await fetch(withTok(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, text: await r.text() };
}

// A local-loopback URL clicked in a node terminal isn't reachable from the
// viewer's browser — recognise it so we can offer to publish it instead.
function localhostPort(uri: string): number | null {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const h = u.hostname;
  if (h !== "localhost" && h !== "127.0.0.1" && h !== "0.0.0.0" && h !== "::1") return null;
  const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
  return port >= 1 && port <= 65535 ? port : null;
}

// Ask, then publish 127.0.0.1:<port> on the clicked node's machine through
// agent-yes.com and open the one-time claim link (sets the 8h cookie).
async function exposeFromRgui(port: number, src: string): Promise<void> {
  if (!confirm(`Expose localhost:${port} on agent-yes.com?\n\nA private link tunnels to this port on the agent's machine. Only someone with the one-time claim link (opens now) can reach it. Revoke from the /w/ console's ports manager.`))
    return;
  const r = await apiPost("/api/expose", { port }, src);
  let info: ExposureInfo & { claim?: string };
  try {
    info = JSON.parse(r.text);
  } catch {
    alert(`Couldn't expose port ${port} — is the daemon reachable?`);
    return;
  }
  if (r.ok && info.claim) {
    window.open(info.claim, "_blank", "noopener,noreferrer");
    void fetchHosts(); // refresh the env node's exposed row promptly
  } else {
    alert(`Couldn't expose port ${port}: ${r.text}`);
  }
}

// Subscribe to an SSE-style stream over one wire. onData receives each parsed
// `data:` value (the raw terminal chunk) — identical to what an
// EventSource.onmessage handler gets after JSON.parse(ev.data). Returns a handle
// with .close() (drop-in for the EventSource the terminals used to hold).
interface Sub {
  close(): void;
}
function subscribeRaw(path: string, onData: (v: unknown) => void, src: string = LOCAL): Sub {
  const w = wires.get(src);
  if (!wireReady(w)) return { close() {} };
  if (w.kind === "rtc") {
    // room.subscribe yields raw DataChannel bytes — reassemble the SSE `data:`
    // frames exactly the way the console's rtcTx does.
    let buf = "";
    const unsub = w.client!.subscribe(path, (raw: string) => {
      buf += raw;
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const evt = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of evt.split("\n"))
          if (line.startsWith("data:")) {
            try {
              onData(JSON.parse(line.slice(5).trim()));
            } catch {
              /* keepalive / non-JSON frame */
            }
          }
      }
    });
    return { close: unsub };
  }
  const ev = new EventSource(withTok(path));
  ev.onmessage = (e) => {
    try {
      onData(JSON.parse(e.data));
    } catch {
      /* non-JSON keepalive frame */
    }
  };
  return { close: () => ev.close() };
}

// ── node geometry (world units) ──────────────────────────────────────────────
// Leaf cards use ~a terminal's aspect ratio (80×24 + a title bar ≈ 1.3:1) so the
// live-terminal overlay (scale:"fit") fills the node instead of letterboxing and
// letting the canvas card bleed around it.
const CARD_W = 320;
const CARD_H = 236;
const PAD = 18; // inner padding of a container frame
const HEADER = 46; // room the container title needs above its children
const GAP = 14; // gap between siblings inside a container
const ROW_GAP = 30; // gap between top-level subtrees
const WRAP_W = 3400; // wrap top-level subtrees to a new band past this x

// ── the in-world "what is this" card ─────────────────────────────────────────
// A world-space node (pans/zooms with the canvas, unlike the screen-fixed status
// palette) that says what agent-yes is and how to install it. It's the stable
// default the page always shows — the anchor a first-time /r/ visitor lands on,
// whether or not any live room is attached. Positioned above the forest so it
// never overlaps agents; drawn on the canvas for the zoomed-out LOD and mirrored
// by a copyable HTML overlay (install commands + copy buttons) up close.
const INFO_ID = "info:card";
const INFO_W = 560;
const INFO_H = 320;
const SETUP_SH = "curl -fsSL https://agent-yes.com/setup.sh | sh";
const SETUP_PS = 'powershell -c "irm https://agent-yes.com/setup.ps1 | iex"';

// User-set per-node magnify (rgui contentScale via shift+drag on the corner
// grip), remembered by node id so a manual "magnify this agent to watch it"
// survives the setGraph that a spawn/exit elsewhere triggers — buildGraph
// re-applies it to the rebuilt node. onNodeResizeEnd keeps this in sync.
const scaleByNode = new Map<string, number>();

// status → rgui category (open string; rgui derives a stable color per string)
const CATEGORY: Record<AgentStatus, string> = {
  active: "active",
  needs_input: "waiting",
  stuck: "stuck",
  idle: "idle",
  exited: "exited",
};

// Repo key = the worktree root, everything before "/tree/" in the cwd — so every
// branch worktree of one repo (…/owner/repo/tree/<branch>[/lib/…]) shares a key.
// Label = owner/repo.
function repoOf(cwd: string): { key: string; label: string } {
  const key = cwd.split("/tree/")[0]!.replace(/\/+$/, "");
  const parts = key.split("/");
  return { key, label: parts.slice(-2).join("/") || key };
}

const home = "/Users/";
function shortCwd(cwd: string): string {
  // ~/ws/snomiao/agent-yes/tree/rgui → …/agent-yes/tree/rgui
  const parts = cwd.replace(/^\/(Users|home)\/[^/]+\//, "~/").split("/");
  return parts.length > 4 ? "…/" + parts.slice(-3).join("/") : cwd.replace(home, "~/");
}

function ago(ts?: number): string {
  if (!ts) return "";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// A short node title: prefer the agent's OSC terminal title (what the console
// shows — e.g. the current task), else fall back to cli + branch.
function nodeTitle(r: AgentRecord): string {
  const osc = (r.title ?? "").replace(/[⠁-⣿]/g, "").trim(); // drop braille spinner glyphs
  if (osc) return osc.length > 52 ? osc.slice(0, 52) + "…" : osc;
  return r.git?.branch ? `${r.cli} ⎇${r.git.branch}` : r.cli;
}

// An agent node's ports model the SEMANTIC signals that flow between agents —
// deliberately NOT the raw CLI stdout (that byte stream, ANSI and all, is the
// node's terminal BODY / content, not a typed value). stdout is parsed (by the
// runtime + /api/ls) into these:
//   inputs  — `prompt` (what you `ay send` it) · `reads` (upstream work/deps it tails)
//   outputs — `status` (its derived state, the primary signal) · `ask` (the
//             question it emits when it needs input — what a parent reacts to) ·
//             `result` (the artifact it produced: its branch)
function portsOf(r: AgentRecord): { inputs: Port[]; outputs: Port[] } {
  const branch = r.git?.branch ?? null;
  const inputs: Port[] = [
    { id: "prompt", label: "prompt", kind: "ctl" },
    { id: "deps", label: "reads", kind: "text" },
    // env input (otoji environment-node parity): which environment this agent
    // runs in. Fed by the host env node / its cwd container, metadata-only.
    { id: "env", label: "env", kind: "environment" },
  ];
  // status output: kind = the status string so the port dot is color-coded per
  // state (stable hashed color); the label (shown zoomed in) is the state text.
  const outputs: Port[] = [{ id: "status", label: r.status, kind: r.status }];
  if (r.question) outputs.push({ id: "ask", label: "needs input", kind: "ctl" });
  if (branch) outputs.push({ id: "result", label: (r.git?.dirty ? "±" : "") + branch, kind: "text" });
  return { inputs, outputs };
}

function nodeOf(r: AgentRecord): GraphNode {
  const branch = r.git?.branch ?? null;
  const prompt = (r.prompt ?? "").replace(/\s+/g, " ").trim();
  const fields: [string, string][] = [
    ["pid", String(r.pid)],
    ["status", r.status],
    ["cwd", shortCwd(r.cwd)],
  ];
  if (r._src !== LOCAL) fields.push(["room", r._src]); // which machine (multi-source fleet)
  if (branch) fields.push(["branch", (r.git?.dirty ? "±" : "") + branch]);
  if (r.last_active_at) fields.push(["active", ago(r.last_active_at) + " ago"]);
  if (r.question) fields.push(["waiting", r.question.slice(0, 48)]);
  else if (prompt) fields.push(["prompt", prompt.slice(0, 56) + (prompt.length > 56 ? "…" : "")]);
  return {
    id: r._key,
    title: nodeTitle(r),
    category: CATEGORY[r.status] ?? r.status,
    x: 0,
    y: 0,
    w: CARD_W,
    ...portsOf(r), // semantic prompt/reads in, status/ask/result out (see portsOf)
    fields,
  };
}

/**
 * Build an rgui Graph from the agent records: parent linkage via
 * `child.parent_pid === parent.wrapper_pid` → rgui `parent` (containment), then
 * a simple recursive pack — leaves are cards, a node with children grows into a
 * frame that wraps its children in a column. Roots tile left-to-right, wrapping
 * into bands so a wide forest stays scannable.
 */
function buildGraph(records: AgentRecord[]): Graph {
  const byKey = new Map<string, AgentRecord>();
  for (const r of records) byKey.set(r._key, r);
  // wrapper_pid → the agent it belongs to, so a child's parent_pid resolves to a
  // node id. Scoped per SOURCE — pids from different machines can collide.
  const ownerOfWrapper = new Map<string, string>();
  for (const r of records)
    if (r.wrapper_pid != null) ownerOfWrapper.set(`${r._src}:${r.wrapper_pid}`, r._key);

  const nodes = new Map<string, GraphNode>();
  const children = new Map<string, string[]>();
  for (const r of records) {
    const n = nodeOf(r);
    nodes.set(n.id, n);
    children.set(n.id, []);
  }
  // Spawn nesting is kept only WITHIN a cwd: a subagent whose parent is in the
  // SAME worktree nests under it; a subagent whose parent works elsewhere becomes
  // a root of its OWN cwd — so agents sharing a worktree snap together regardless
  // of who spawned them (cross-cwd spawn links are dropped here, candidates for a
  // future wire). cwd is the primary "workspace" unit; spawn is secondary.
  const cwdRoots: string[] = [];
  for (const r of records) {
    const id = r._key;
    const parentKey =
      r.parent_pid != null ? ownerOfWrapper.get(`${r._src}:${r.parent_pid}`) : undefined;
    const parentSameCwd =
      parentKey != null &&
      parentKey !== r._key &&
      nodes.has(parentKey) &&
      byKey.get(parentKey)!.cwd === r.cwd;
    if (parentSameCwd) {
      nodes.get(id)!.parent = parentKey;
      children.get(parentKey)!.push(id);
    } else {
      cwdRoots.push(id);
    }
  }

  // Snap agents together by cwd, then by repo — scoped per source (the same
  // path on two machines is two different worktrees). Agents in the SAME cwd
  // cluster into a same-cwd container that surfaces their SHARED state (the
  // loudest member — needs_input > stuck > active > idle); same-repo cwds then
  // cluster into the repo container. A cwd/repo with a single member stays loose.
  cwdGroups.clear();
  const byRepo = new Map<string, string[]>();
  for (const id of cwdRoots) {
    const r = byKey.get(id)!;
    const key = `${r._src}:${repoOf(r.cwd).key}`;
    (byRepo.get(key) ?? byRepo.set(key, []).get(key)!).push(id);
  }
  const topLevel: string[] = [];
  for (const [srcRepoKey, repoIds] of byRepo) {
    const repoKey = srcRepoKey.slice(srcRepoKey.indexOf(":") + 1);
    // sub-group this repo's agents by EXACT cwd (same worktree)
    const byCwd = new Map<string, string[]>();
    for (const id of repoIds) {
      const cwd = byKey.get(id)!.cwd;
      (byCwd.get(cwd) ?? byCwd.set(cwd, []).get(cwd)!).push(id);
    }
    const repoChildren: string[] = [];
    for (const [cwd, cids] of byCwd) {
      if (cids.length < 2) {
        repoChildren.push(...cids);
        continue;
      }
      const st = aggStateOf(cids);
      const cwdId = `cwd:${srcRepoKey.slice(0, srcRepoKey.indexOf(":"))}:${cwd}`;
      cwdGroups.set(cwdId, cids);
      nodes.set(cwdId, {
        id: cwdId,
        title: cwd.slice(repoKey.length).replace(/^\/(tree\/)?/, "") || cwd,
        category: `cwd-${st}`, // header colored by the group's shared state
        x: 0,
        y: 0,
        w: CARD_W,
        // the cwd container IS the worktree environment node — env in from the
        // host, and (metadata-only) it provides the env its members run in
        inputs: [{ id: "env", label: "env", kind: "environment" }],
        outputs: [],
        fields: cwdFields(cids),
      });
      children.set(cwdId, cids);
      for (const id of cids) nodes.get(id)!.parent = cwdId;
      repoChildren.push(cwdId);
    }
    if (repoChildren.length < 2) {
      topLevel.push(...repoChildren);
      continue;
    }
    const repoId = `repo:${srcRepoKey}`;
    nodes.set(repoId, {
      id: repoId,
      title: repoOf(byKey.get(repoIds[0]!)!.cwd).label,
      category: "repo",
      x: 0,
      y: 0,
      w: CARD_W,
      // env in from the host env node (the repo's worktrees live on that machine)
      inputs: [{ id: "env", label: "env", kind: "environment" }],
      outputs: [],
      fields: [["worktrees", String(byCwd.size)]],
    });
    children.set(repoId, repoChildren);
    for (const id of repoChildren) nodes.get(id)!.parent = repoId;
    topLevel.push(repoId);
  }

  // Recursive shelf-pack. Children (which vary a lot in size — a leaf card vs a
  // deep agent sub-tree) are SIZED first, then arranged left-to-right and wrapped
  // to a target row width chosen for a roughly-landscape block, so a 20-branch
  // repo becomes a compact grid instead of one very tall column.
  function pack(id: string, x: number, y: number): { w: number; h: number } {
    const node = nodes.get(id)!;
    node.x = x;
    node.y = y;
    const kids = children.get(id) ?? [];
    if (kids.length === 0) {
      node.w = CARD_W;
      node.h = CARD_H;
      return { w: CARD_W, h: CARD_H };
    }
    const sizes = kids.map((k) => pack(k, 0, 0)); // measure subtrees (temp position)
    const totalArea = sizes.reduce((a, s) => a + s.w * s.h, 0);
    const maxChildW = Math.max(...sizes.map((s) => s.w));
    const target = Math.max(maxChildW, Math.sqrt(totalArea) * 1.5); // ~1.5:1 landscape
    let cx = x + PAD;
    let cy = y + HEADER;
    let rowH = 0;
    let maxRight = x + PAD;
    for (let i = 0; i < kids.length; i++) {
      if (cx > x + PAD && cx + sizes[i]!.w > x + PAD + target) {
        cx = x + PAD; // wrap to next shelf
        cy += rowH + GAP;
        rowH = 0;
      }
      pack(kids[i]!, cx, cy); // final placement (re-lays the subtree at cx,cy)
      cx += sizes[i]!.w + GAP;
      rowH = Math.max(rowH, sizes[i]!.h);
      maxRight = Math.max(maxRight, cx - GAP);
    }
    node.w = Math.max(CARD_W, maxRight - x + PAD);
    node.h = cy + rowH + PAD - y;
    return { w: node.w, h: node.h };
  }

  // Host environment nodes (otoji environment-node adoption): one ⬢ node per
  // SOURCE whose /api/host answered — identity, live load/mem, capability
  // flags (see hostEnvFields) — wired env→ into that source's own top-level
  // roots only (a room's agents belong to the room's machine, not the local
  // one). Absent for wires whose daemon predates /api/host.
  envEdges.length = 0;
  const srcOfRoot = (id: string): string => {
    if (id.startsWith("cwd:") || id.startsWith("repo:")) {
      const rest = id.slice(id.indexOf(":") + 1);
      return rest.slice(0, rest.indexOf(":"));
    }
    return byKey.get(id)?._src ?? LOCAL;
  };
  const envNodes: string[] = [];
  for (const w of wires.values()) {
    if (!w.hostInfo) continue;
    const envId = envIdOf(w.id);
    nodes.set(envId, {
      id: envId,
      title: `⬢ ${w.hostInfo.host}${w.kind === "rtc" ? ` · ${w.id}` : ""}`,
      category: "environment",
      x: 0,
      y: 0,
      w: CARD_W,
      inputs: [],
      outputs: [{ id: "env", label: "env", kind: "environment" }],
      fields: hostEnvFields(w.id),
    });
    children.set(envId, []);
    // this host's env → each of ITS top-level roots (repo/cwd containers +
    // loose agents); members nested inside a container inherit it visually
    for (const id of topLevel) {
      if (srcOfRoot(id) !== w.id) continue;
      envEdges.push({
        from: { node: envId, port: "env" },
        to: { node: id, port: "env" },
        dashed: true,
        style: { color: "#805ad5", width: 1.5, dash: [3, 5] },
      });
    }
    envNodes.push(envId);
  }
  topLevel.unshift(...envNodes);

  // tile the top-level nodes (repo containers + loose agents) into bands
  let x = 0;
  let bandY = 0;
  let bandH = 0;
  for (const id of topLevel) {
    const s = pack(id, x, bandY);
    x += s.w + ROW_GAP;
    bandH = Math.max(bandH, s.h);
    if (x > WRAP_W) {
      x = 0;
      bandY += bandH + ROW_GAP;
      bandH = 0;
    }
  }

  // Place the "what is this" card above the forest (its own band), left-aligned,
  // so a full-forest fit frames both. It's a first-class rgui annotation/sticky
  // card (note node): the copyable install commands are its HTML body (el), with
  // drawInfoCard as the canvas LOD body shown when the overlay hides far out.
  // scale:"fit" makes the body track its world-space frame (annotationNode's
  // default body is screen-fixed).
  nodes.set(
    INFO_ID,
    annotationNode({
      id: INFO_ID,
      x: 0,
      y: -(INFO_H + ROW_GAP + 20),
      w: INFO_W,
      h: INFO_H,
      el: ensureInfoOverlay(),
      draw: drawInfoCard,
      bg: isLight() ? "#ffffff" : "#0d1117",
      scale: "fit",
      minScale: 0.16, // readable at the default forest fit; hides only far out
      // uncapped: the card is world-space (natural px == world units), so the
      // overlay must keep scaling past 1× to stay glued over its frame — capped
      // at 1 it froze at 560×320 while the canvas LOD body kept growing behind
      // it, showing both layers at once when zoomed in
      maxScale: Infinity,
      clip: "node",
      overflow: "hidden",
    }),
  );
  children.set(INFO_ID, []);

  // containers (nodes with children) render as frames around their kids — a
  // terminal "over" them would cover the children, so only LEAF agents get a
  // live terminal overlay.
  isContainer = new Set([...children].filter(([, k]) => k.length > 0).map(([id]) => id));
  // leaf agent nodes render via our LOD draw hook (terminal snapshot / identity),
  // instead of rgui's default field card — see drawNode.
  for (const n of nodes.values()) {
    if (
      !isContainer.has(n.id) &&
      !n.id.startsWith("repo:") &&
      !n.id.startsWith("info:") &&
      !n.id.startsWith("env:") // env node has no terminal — default field card
    ) {
      n.draw = (ctx, r) => drawNode(n.id, ctx, r);
    }
  }
  return { nodes: [...nodes.values()], edges: [] };
}

// ── a baked sample forest (shown when no /api/ls is reachable) ────────────────
function sampleRecords(): AgentRecord[] {
  const now = Date.now();
  const mk = (
    pid: number,
    cli: string,
    status: AgentStatus,
    cwd: string,
    branch: string,
    prompt: string,
    extra: Partial<AgentRecord> = {},
  ): AgentRecord => ({
    pid,
    cli,
    status,
    cwd,
    prompt,
    started_at: now - 600_000,
    last_active_at: now - (extra.last_active_at ?? 30_000),
    git: { branch },
    _src: LOCAL,
    _key: `${LOCAL}#${pid}`,
    ...extra,
  });
  return [
    mk(1001, "claude", "active", "~/ws/acme/agent-yes/tree/rgui", "rgui", "impl /rgui + ship to pages", { wrapper_pid: 1001 }),
    mk(1002, "claude", "idle", "~/ws/acme/rgui/tree/main", "main", "rgui heavy dev — org-chart containers", { wrapper_pid: 1002 }),
    // a parent agent (wrapper 1003) with two subagents nested inside it
    mk(1003, "claude", "active", "~/ws/acme/api/tree/main", "chore/pin-bump", "goal: pin bump wave", { wrapper_pid: 1003 }),
    mk(1004, "claude", "idle", "~/ws/acme/api/tree/proxy", "proxy", "proxy work", { wrapper_pid: 1004, parent_pid: 1003 }),
    mk(1005, "claude", "needs_input", "~/ws/acme/api/tree/main/lib/edge", "feat/force-h1", "force h1 land — awaiting review", { wrapper_pid: 1005, parent_pid: 1003, question: "Proceed with merge?" }),
    mk(1006, "claude", "idle", "~/ws/acme/tools/tree/main", "main", "tooling", { wrapper_pid: 1006 }),
    mk(1007, "claude", "stuck", "~/ws/acme/web/tree/main", "main", "resume web build", { wrapper_pid: 1007 }),
  ];
}

// ─── per-node live terminals ──────────────────────────────────────────────────
// Reuse the console's xterm.js (loaded from the same CDN in index.html) + its
// raw tail protocol: each on-screen, large-enough LEAF node gets an xterm sized
// to the agent's NATIVE cols/rows (from /api/size — we never push a resize, so
// we don't fight the real user's PTY) and tails /api/tail/<pid>?raw=1. rgui glues
// the panel over the node (scale:"fit"), so zoomed in you see the live terminal,
// zoomed out the summary card. Virtualized + capped so we never run 40 terminals.
let isContainer = new Set<string>();
const recordsByKey = new Map<string, AgentRecord>();

// relationship wires: recent agent→agent read/tail edges (from /api/edges).
// Fetched per wire; by/target are node KEYS (`<src>#<pid>`) after mapping —
// a read edge never crosses sources (the daemon only sees its own agents).
interface ReadEdge {
  by: string;
  target: string;
  at: number;
}
let readEdges: ReadEdge[] = [];
let showWires = true;

// message wires: recent agent→agent SENDS (`ay send`/`key`/`select`, from
// /api/edges `sends`). Unlike a read edge — a standing "X watches Y" relation —
// a send is an EVENT: it flashes bright at delivery and fades out over
// SEND_FADE_MS, so the forest shows message traffic as it happens rather than a
// permanent wire. Same node-KEY mapping; `kind` distinguishes a keystroke/menu
// pick from a text message.
interface SendEdge {
  by: string;
  target: string;
  at: number;
  kind?: "key" | "select";
}
let sendEdges: SendEdge[] = [];
/** A send wire is fully opaque at delivery and gone this long after. */
const SEND_FADE_MS = 20_000;
/** Repaint cadence while any send wire is still fading (smooth decay). */
const SEND_FADE_TICK_MS = 250;
let sendFadeTimer: ReturnType<typeof setInterval> | null = null;

/** Remaining life of a send edge, 1 at delivery → 0 once fully faded. */
function sendAlpha(at: number): number {
  return Math.max(0, Math.min(1, 1 - (Date.now() - at) / SEND_FADE_MS));
}

/**
 * Keep repainting while any send wire is mid-fade, then stop. Without this the
 * wires would only redraw on a structure change or the edge poll, so the decay
 * would step coarsely instead of easing out.
 */
function ensureSendFadeTicker() {
  const alive = sendEdges.some((e) => sendAlpha(e.at) > 0);
  if (alive && !sendFadeTimer) {
    sendFadeTimer = setInterval(() => {
      if (!sendEdges.some((e) => sendAlpha(e.at) > 0)) {
        sendEdges = [];
        clearInterval(sendFadeTimer!);
        sendFadeTimer = null;
      }
      applyEdges();
    }, SEND_FADE_TICK_MS);
  }
}

// same-cwd groups (cwdId → member pids); their container surfaces the group's
// SHARED state (the loudest member), refreshed on every content poll.
const cwdGroups = new Map<string, string[]>();
const STATE_RANK: AgentStatus[] = ["needs_input", "stuck", "active", "idle", "exited"];
function aggStateOf(pids: string[]): AgentStatus {
  const s = new Set(pids.map((p) => recordsByKey.get(p)?.status).filter(Boolean));
  return STATE_RANK.find((x) => s.has(x)) ?? "idle";
}

// Body rows of a cwd (worktree environment) container. 2+ LIVE agents in one
// worktree share its branch, git index and bun-link targets — a real hazard
// (they silently commit onto each other's branch), so it gets a ⚠ row.
function cwdFields(pids: string[]): [string, string][] {
  const live = pids.filter((p) => recordsByKey.get(p)?.status !== "exited").length;
  const fields: [string, string][] = [
    ["agents", String(pids.length)],
    ["shared", aggStateOf(pids)],
  ];
  if (live >= 2) fields.push(["⚠", `${live} live agents share this worktree`]);
  return fields;
}

const MAX_TERMS = 6; // cap concurrent xterms/SSE streams — `ay serve --http` gets
// unresponsive under many concurrent /api/tail streams, and a stalled stream
// auto-reconnects (re-sending a full snapshot = a repaint/flash)
const TERM_MIN_W = 210; // node must be at least this wide on screen to earn a terminal
const TERM_MIN_H = 120;
const TERM_DROP_TICKS = 3; // ticks a terminal may stay unwanted before teardown

type Xterm = {
  write(d: string): void;
  open(el: HTMLElement): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
  focus(): void;
  onData(cb: (d: string) => void): void;
  options: Record<string, unknown>;
};
const XTermCtor = (window as unknown as { Terminal?: new (o: unknown) => Xterm }).Terminal;

// console's GitHub dark/light terminal palettes (kept legible on a white bg)
const prefersLight = matchMedia("(prefers-color-scheme: light)");
function isLight() {
  return (document.documentElement.dataset.theme ?? (prefersLight.matches ? "light" : "dark")) === "light";
}
function termTheme() {
  return isLight()
    ? {
        background: "#ffffff", foreground: "#1f2328", cursor: "#1f2328",
        selectionBackground: "#b6d6ff", black: "#24292e", red: "#cf222e", green: "#116329",
        yellow: "#4d2d00", blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
        brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37", brightYellow: "#633c01",
        brightBlue: "#218bff", brightMagenta: "#a475f9", brightCyan: "#3192aa", brightWhite: "#1f2328",
      }
    : { background: "#0d1117", foreground: "#c9d1d9", cursor: "#0d1117" };
}

interface TermEntry {
  el: HTMLElement;
  term: Xterm;
  es: Sub; // stream handle (EventSource over HTTP, or the room DataChannel sub)
  miss: number; // consecutive ticks unwanted (grace before teardown)
  buf: string; // stream bytes deferred while the view moves (flushed on settle)
}
const terms = new Map<string, TermEntry>();

// Timestamp of the last view change — terminals are only reconciled once the view
// has been still for a bit, so a zoom/pan never opens/closes SSE streams mid-
// gesture (that churn leaks server-side FIFO watchers and triggers reconnect
// repaints = flashing). Existing terminals stay put and just scale during motion.
let lastViewChangeAt = 0;
let prevK = 0;
let prevX = 0;
let prevY = 0;
const SETTLE_MS = 180;
let deferredWhileMoving = 0; // QA metric (see #qa): stream bytes deferred mid-gesture

// Direct typing: pump xterm keystrokes (onData raw bytes — printable keys,
// \r, arrows, ctrl-*) into the agent's PTY via POST /api/send {code:"none"}
// (a bare writeToIpc — no trailing Enter). A promise chain keeps byte order;
// per-keystroke POSTs are fine on both wires (HTTP and the room DataChannel).
// Read-only shares deny host-side (403) — surface it once, don't spam.
function attachStdin(term: Xterm, key: string, onDenied: () => void) {
  let chain = Promise.resolve();
  let denied = false;
  term.onData((data) => {
    if (term.options.disableStdin) return;
    chain = chain.then(async () => {
      const r = await apiPost(
        "/api/send",
        { keyword: pidOf(key), msg: data, code: "none" },
        srcOf(key),
      );
      if (!r.ok && !denied) {
        denied = true;
        onDenied();
      }
    });
  });
}

function makeTerm(pid: string): TermEntry | null {
  // `pid` here is the node KEY (`<src>#<pid>`) — kept as the param name the rest
  // of the terminal machinery uses; the wire + real pid derive from it below.
  const src = srcOf(pid);
  const rawPid = pidOf(pid);
  const r = recordsByKey.get(pid);
  if (!XTermCtor || !r) return null;
  const el = document.createElement("div");
  el.className = "ay-term";
  el.dataset.rguiInteractive = "1"; // let scroll/select inside the terminal work
  // right-click on the live terminal = right-click on the node: open the send
  // menu instead of the browser menu — without this a terminal-covered card has
  // NO input path at all (the room/share view is exactly one such card)
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openBatchMenu(e.clientX, e.clientY, [pid]);
  });
  // click-to-type: arming the terminal routes keystrokes STRAIGHT into the
  // agent's PTY (green outline = live stdin); click anywhere outside releases
  const arm = (on: boolean) => {
    el.classList.toggle("stdin", on);
    term.options.disableStdin = !on;
    term.options.cursorBlink = on;
    if (on) term.focus();
  };
  el.addEventListener("mousedown", (e) => {
    if (e.button === 0) arm(true);
  });
  addEventListener(
    "mousedown",
    (e) => {
      if (!el.contains(e.target as Node)) arm(false);
    },
    true,
  );
  const bar = document.createElement("div");
  bar.className = "ay-term-bar";
  bar.innerHTML =
    `<span class="dot ${r.status}"></span>` +
    `<span class="t"></span><span class="pid">#${rawPid}${src === LOCAL ? "" : ` · ${src}`}</span>`;
  (bar.querySelector(".t") as HTMLElement).textContent = nodeTitle(r);
  const body = document.createElement("div");
  body.className = "ay-term-body";
  el.append(bar, body);

  const term = new XTermCtor({
    fontSize: 11, // smaller native canvas → cheaper to composite/scale during zoom
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    theme: termTheme(),
    disableStdin: true, // read-only mirror
    cursorBlink: false,
    scrollback: 200,
    convertEol: false,
  });
  term.open(body);
  // render to a <canvas> bitmap so rgui's per-frame transform:scale() during zoom
  // is a cheap GPU composite, not a full xterm char-remeasure + re-render (the
  // DOM renderer re-measures because getBoundingClientRect includes the scale).
  const CanvasAddon = (window as unknown as { CanvasAddon?: { CanvasAddon: new () => unknown } })
    .CanvasAddon?.CanvasAddon;
  if (CanvasAddon) {
    try {
      (term as unknown as { loadAddon(a: unknown): void }).loadAddon(new CanvasAddon());
    } catch {
      /* addon unavailable — fall back to the DOM renderer */
    }
  }
  // Clickable URLs. A localhost link offers to publish through agent-yes.com on
  // THIS node's machine (src); any other URL just opens in a new tab.
  const WebLinks = (window as unknown as { WebLinksAddon?: { WebLinksAddon: new (h: (e: MouseEvent, uri: string) => void) => unknown } })
    .WebLinksAddon?.WebLinksAddon;
  if (WebLinks) {
    try {
      (term as unknown as { loadAddon(a: unknown): void }).loadAddon(
        new WebLinks((_e: MouseEvent, uri: string) => {
          const port = localhostPort(uri);
          if (port != null) void exposeFromRgui(port, src);
          else window.open(uri, "_blank", "noopener,noreferrer");
        }),
      );
    } catch {
      /* addon CDN blocked — terminal still works, just without auto-links */
    }
  }

  // #nostream (debug): skip the live SSE so the page reaches network-idle and rech
  // can drive it; render a static pattern so the overlay still has content/size.
  const noStream = location.hash.includes("nostream");
  // Stream handler shared by both wires (HTTP EventSource or the room channel):
  // while the view is moving, DEFER writes — repainting the xterm canvas while
  // rgui is CSS-scaling it every frame re-rasters = the zoom flash. Buffer now,
  // flush once the view settles (see the settle interval).
  const onStream = (data: unknown) => {
    const s = data as string;
    if (Date.now() - lastViewChangeAt < SETTLE_MS) {
      entry.buf += s;
      deferredWhileMoving++; // QA metric: stream bytes that arrived mid-gesture
    } else term.write(s);
  };
  const es: Sub = noStream
    ? { close() {} }
    : subscribeRaw(`/api/tail/${encodeURIComponent(rawPid)}?raw=1`, onStream, src);
  const entry: TermEntry = { el, term, es, miss: 0, buf: "" };
  attachStdin(term, pid, () => {
    const prev = statusLabel.textContent;
    statusLabel.textContent = "⌨ input denied — read-only share";
    setTimeout(() => {
      if (statusLabel.textContent?.startsWith("⌨")) statusLabel.textContent = prev;
    }, 2500);
  });
  if (noStream) {
    for (let i = 0; i < 20; i++) term.write(`row ${i} · #${pid} · nostream debug pattern\r\n`);
  }

  // size probe (only under #qa): log the overlay's natural px once xterm lays out
  if (location.hash === "#qa")
    requestAnimationFrame(() =>
      console.log(
        `[rgui-term] pid=${pid} el=${el.offsetWidth}x${el.offsetHeight}px ` +
          `= ${((el.offsetWidth * el.offsetHeight) / 1e6).toFixed(2)}MPx`,
      ),
    );

  // size to the agent's native grid so the absolute-cursor raw stream lands
  // correctly; NO resize is pushed back to the PTY.
  apiJSON<{ cols?: number; rows?: number }>(`/api/size/${encodeURIComponent(rawPid)}`, src)
    .then((s) => {
      if (s?.cols && s?.rows && terms.get(pid) === entry) term.resize(s.cols, s.rows);
    })
    .catch(() => {});

  viewer.setNodeOverlay(pid, {
    el,
    anchor: "over",
    scale: "fit",
    // only reveal the terminal once it's big enough to read — agents with a large
    // PTY (e.g. 160×50) would otherwise show as an illegible thumbnail; below this
    // the node's summary card takes over (true semantic zoom: zoom in for the
    // live terminal, out for the card).
    minScale: 0.34,
    // upscale past the terminal's native px to FILL a larger node (rgui caps at 1
    // by default = crisp but the card shows around it at high zoom); 4× keeps it
    // legible-ish while filling.
    maxScale: 4,
    clip: "node",
    overflow: "hidden",
    interactive: true,
  });
  // rgui now owns overlay-layer stacking (sits at canvas z-index + 1 after the
  // WebGPU→canvas2d fallback), so no host z-index lift is needed here anymore.
  return entry;
}

function dropTerm(pid: string) {
  const e = terms.get(pid);
  if (!e) return;
  terms.delete(pid);
  try {
    e.es.close();
  } catch {
    /* */
  }
  try {
    e.term.dispose();
  } catch {
    /* */
  }
  viewer.setNodeOverlay(pid, null);
}

// ── snapshot LOD + zoomed-out identity ────────────────────────────────────────
// A leaf agent node's canvas content (rgui `node.draw`) is our own LOD ladder,
// UNDER the live html-terminal overlay: zoomed in the overlay covers it; below
// the overlay's readable scale we draw a SNAPSHOT of how the terminal looked
// (grabbed off the canvas-renderer's <canvas> while it was live); zoomed out
// small, just the identity+title row (like the console's left-side list).
const DOT_COLOR: Record<string, string> = {
  active: "#3fb950",
  needs_input: "#d29922",
  stuck: "#f85149",
  exited: "#6e7781",
  idle: "#8b949e",
};
const snapshots = new Map<string, HTMLCanvasElement>();

// grab the live terminal's rendered pixels (canvas renderer → real <canvas>es)
// into an offscreen canvas we keep after the live terminal is torn down.
function captureSnapshot(id: string, entry: TermEntry) {
  const cvs = entry.el.querySelectorAll("canvas");
  if (!cvs.length) return;
  let w = 0;
  let h = 0;
  cvs.forEach((c) => {
    w = Math.max(w, (c as HTMLCanvasElement).width);
    h = Math.max(h, (c as HTMLCanvasElement).height);
  });
  if (!w || !h) return;
  let off = snapshots.get(id);
  if (!off) {
    off = document.createElement("canvas");
    snapshots.set(id, off);
  }
  if (off.width !== w || off.height !== h) {
    off.width = w;
    off.height = h;
  }
  const octx = off.getContext("2d")!;
  octx.fillStyle = isLight() ? "#ffffff" : "#0d1117";
  octx.fillRect(0, 0, w, h);
  cvs.forEach((c) => {
    try {
      octx.drawImage(c as HTMLCanvasElement, 0, 0);
    } catch {
      /* tainted/empty — skip */
    }
  });
}

// rgui node.draw for leaf agents (rgui still paints the border/selection). Title
// bar (status dot + OSC title) + body = terminal snapshot when there's room, else
// a compact identity block.
function drawNode(
  id: string,
  ctx: CanvasRenderingContext2D,
  rect: { width: number; height: number },
) {
  const r = recordsByKey.get(id);
  const light = isLight();
  const w = rect.width;
  const h = rect.height;
  const barH = Math.max(14, Math.min(26, h * 0.16));
  ctx.fillStyle = light ? "#f3f1ea" : "#161b22";
  ctx.fillRect(0, 0, w, barH);
  if (r) {
    ctx.beginPath();
    ctx.arc(barH * 0.55, barH * 0.5, Math.max(2, barH * 0.16), 0, Math.PI * 2);
    ctx.fillStyle = DOT_COLOR[r.status] ?? "#8b949e";
    ctx.fill();
    ctx.fillStyle = light ? "#22262b" : "#c9d1d9";
    ctx.font = `600 ${Math.max(7, Math.min(14, barH * 0.6))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textBaseline = "middle";
    ctx.save();
    ctx.beginPath();
    ctx.rect(barH, 0, w - barH - 4, barH);
    ctx.clip();
    ctx.fillText(nodeTitle(r), barH * 1.05, barH * 0.56);
    ctx.restore();
  }
  const bodyY = barH;
  const bodyH = h - barH;
  ctx.fillStyle = light ? "#ffffff" : "#0d1117";
  ctx.fillRect(0, bodyY, w, bodyH);
  const snap = snapshots.get(id);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, bodyY, w, bodyH);
  ctx.clip();
  if (snap && snap.width && bodyH > 34) {
    // fit width, show the BOTTOM of the terminal (the latest output) — a mini
    // live-terminal thumbnail rather than the top of the scrollback.
    const scale = w / snap.width;
    const srcH = Math.min(snap.height, bodyH / scale);
    ctx.drawImage(snap, 0, snap.height - srcH, snap.width, srcH, 0, bodyY, w, srcH * scale);
  } else if (r && bodyH > 14) {
    ctx.fillStyle = light ? "#69737d" : "#8b949e";
    const fs = Math.max(7, Math.min(12, bodyH * 0.16));
    ctx.font = `${fs}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textBaseline = "top";
    const lines = [
      `#${pidOf(id)}${r._src === LOCAL ? "" : ` · ${r._src}`} · ${r.status}`,
      shortCwd(r.cwd) + (r.git?.branch ? ` ⎇${r.git.branch}` : ""),
    ];
    if (r.question) lines.push(`⏳ ${r.question.slice(0, 40)}`);
    // no terminal to show (demo, or not streamed yet) — fill the body with the
    // agent's prompt (word-wrapped) so the card reads as work-in-flight
    const maxLines = Math.floor((bodyH - 16) / (fs + 3));
    if (r.prompt && lines.length + 2 <= maxLines) {
      lines.push("");
      const maxW = w - 16;
      let ln = "▸";
      for (const wd of r.prompt.split(/\s+/)) {
        const t = `${ln} ${wd}`;
        if (ctx.measureText(t).width > maxW && ln !== "▸") {
          lines.push(ln);
          if (lines.length >= maxLines) break;
          ln = `  ${wd}`;
        } else ln = t;
      }
      if (lines.length < maxLines) lines.push(ln);
    }
    lines.slice(0, maxLines).forEach((ln, i) => ctx.fillText(ln, 8, bodyY + 8 + i * (fs + 3)));
  }
  ctx.restore();
}

// ── the in-world "what is this" card ─────────────────────────────────────────
// Canvas draw (zoomed-out LOD, under the HTML overlay): brand + one-liner + the
// two install commands, so the card reads even when its overlay is hidden.
function drawInfoCard(ctx: CanvasRenderingContext2D, rect: { width: number; height: number }) {
  const light = isLight();
  const w = rect.width;
  const h = rect.height;
  const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillStyle = light ? "#ffffff" : "#0d1117";
  ctx.fillRect(0, 0, w, h);
  const px = w * 0.055;
  let y = h * 0.14;
  ctx.textBaseline = "alphabetic";
  // brand
  ctx.fillStyle = "#ffd60a";
  ctx.font = `700 ${h * 0.085}px ${mono}`;
  ctx.fillText("agent-yes", px, y);
  ctx.fillStyle = light ? "#69737d" : "#8b949e";
  ctx.font = `${h * 0.06}px ${mono}`;
  ctx.fillText(" · console", px + ctx.measureText("agent-yes").width, y);
  // tagline
  y += h * 0.11;
  ctx.fillStyle = light ? "#22262b" : "#c9d1d9";
  ctx.font = `${h * 0.05}px ${mono}`;
  ctx.fillText("Live ay ls + per-agent tail & send.", px, y);
  y += h * 0.075;
  ctx.fillText("Backed by ay serve.", px, y);
  // install command chips
  const chip = (label: string, cmd: string, cy: number) => {
    ctx.fillStyle = light ? "#69737d" : "#6e7781";
    ctx.font = `${h * 0.042}px ${mono}`;
    ctx.fillText(label, px, cy);
    ctx.fillStyle = light ? "#f3f1ea" : "#161b22";
    const bx = px;
    const by = cy + h * 0.02;
    const bw = w - 2 * px;
    const bh = h * 0.085;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 5);
    ctx.fill();
    ctx.fillStyle = light ? "#116329" : "#3fb950";
    ctx.font = `${h * 0.045}px ${mono}`;
    ctx.save();
    ctx.beginPath();
    ctx.rect(bx, by, bw - h * 0.04, bh);
    ctx.clip();
    ctx.textBaseline = "middle";
    ctx.fillText(cmd, bx + h * 0.03, by + bh / 2);
    ctx.restore();
    ctx.textBaseline = "alphabetic";
    return by + bh;
  };
  y = chip("install", SETUP_SH, y + h * 0.11);
  chip("windows", SETUP_PS, y + h * 0.08);
}

// The copyable card body: real selectable text + a copy button per command
// (canvas can't host either). Built once and handed to annotationNode as its
// `el`; rgui glues it over the note-card frame and re-binds it across setGraph.
let infoOverlayEl: HTMLElement | null = null;
function copyRow(label: string, cmd: string): string {
  return (
    `<div class="ay-info-row"><span class="ay-info-lbl">${label}</span>` +
    `<code>${cmd.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</code>` +
    `<button class="ay-info-copy" data-cmd="${cmd.replace(/"/g, "&quot;")}">copy</button></div>`
  );
}
function ensureInfoOverlay(): HTMLElement {
  if (infoOverlayEl) return infoOverlayEl;
  const el = document.createElement("div");
  el.className = "ay-info";
  el.dataset.rguiInteractive = "1";
  el.style.width = `${INFO_W}px`;
  el.style.height = `${INFO_H}px`;
  el.innerHTML =
    `<div class="ay-info-head"><b>agent-yes</b> · console</div>` +
    `<div class="ay-info-tag">Live <code>ay ls</code> + per-agent tail &amp; send. Backed by <code>ay serve</code>.</div>` +
    copyRow("install", SETUP_SH) +
    copyRow("windows", SETUP_PS) +
    `<a class="ay-info-link" href="https://agent-yes.com" target="_blank" rel="noopener">agent-yes.com ↗</a>`;
  el.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".ay-info-copy");
    if (!btn) return;
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(btn.dataset.cmd ?? "");
      const prev = btn.textContent;
      btn.textContent = "copied ✓";
      btn.classList.add("ok");
      setTimeout(() => {
        btn.textContent = prev;
        btn.classList.remove("ok");
      }, 1200);
    } catch {
      /* clipboard blocked — the code is still selectable to copy by hand */
    }
  });
  infoOverlayEl = el;
  return el;
}

// Decide which nodes deserve a live terminal this frame (on-screen leaf nodes,
// big enough, capped by area), create/tear down to match.
let lastTermSync = 0;
function syncTerminals(view: { x: number; y: number; k: number }) {
  if (!XTermCtor) return;
  // live only: demo/sample records have no PTY behind them, so an xterm here
  // could only ever be an empty black window over the card — the summary body
  // (identity + prompt) carries the demo instead
  if (!liveKnown) return;
  const cw = canvas.clientWidth || innerWidth;
  const ch = canvas.clientHeight || innerHeight;
  const cand: { id: string; area: number }[] = [];
  for (const n of viewer.graph.nodes) {
    if (isContainer.has(n.id) || !recordsByKey.has(n.id)) continue; // skip containers + the info card
    const sw = n.w * view.k;
    const sh = (n.h ?? CARD_H) * view.k;
    if (sw < TERM_MIN_W || sh < TERM_MIN_H) continue;
    const sx = n.x * view.k + view.x;
    const sy = n.y * view.k + view.y;
    if (sx + sw < 0 || sx > cw || sy + sh < 0 || sy > ch) continue; // off-screen
    cand.push({ id: n.id, area: sw * sh });
  }
  cand.sort((a, b) => b.area - a.area);
  const wanted = new Set(cand.slice(0, MAX_TERMS).map((c) => c.id));

  for (const id of wanted) if (!terms.has(id)) {
    const e = makeTerm(id);
    if (e) terms.set(id, e);
  }
  for (const [id, e] of terms) {
    if (wanted.has(id)) e.miss = 0;
    else if (++e.miss >= TERM_DROP_TICKS) dropTerm(id);
  }
}

// Selected-node debug panel (#debug2): the selected node's rect and its live
// terminal overlay's rect, in screen px. (rgui owns #debug and rewrites it every
// frame, so we keep our extra readout in a panel we control.)
const debug2El = document.getElementById("debug2");
function updateNodeDebug() {
  if (!debug2El) return;
  const id = viewer.selection[0];
  const node = id ? viewer.graph.nodes.find((n) => n.id === id) : undefined;
  if (!node) {
    debug2El.textContent = "";
    return;
  }
  const v = viewer.view;
  const h = nodeHeight(node); // rgui's effective height (rows-derived if h unset)
  const R = (n: number) => Math.round(n);
  const lines = [
    `sel  #${id} · ${node.category}`,
    `node world  ${R(node.x)},${R(node.y)}  ${R(node.w)}×${R(h)} wu`,
    `node screen ${R(node.x * v.k + v.x)},${R(node.y * v.k + v.y)}  ${R(node.w * v.k)}×${R(h * v.k)} px`,
  ];
  const e = terms.get(id);
  if (e) {
    // the wrap is what rgui positions/scales (clip:"node"); its client rect is the
    // overlay's actual on-screen box.
    const box = (e.el.parentElement ?? e.el).getBoundingClientRect();
    lines.push(
      `ovl  natural ${e.el.offsetWidth}×${e.el.offsetHeight} px`,
      `ovl  screen  ${R(box.x)},${R(box.y)}  ${R(box.width)}×${R(box.height)} px`,
    );
  } else {
    lines.push(`ovl  (none — zoom in on a leaf)`);
  }
  debug2El.textContent = lines.join("\n");
}

// Browser tab title follows the selected agent (name + status glyph), like the
// console's docTitle — else the fleet summary. This IS the "console title".
const STATUS_GLYPH: Record<string, string> = {
  active: "●",
  needs_input: "⌨",
  stuck: "■",
  idle: "○",
  exited: "✕",
};
function updateDocTitle() {
  const id = viewer.selection[0];
  const r = id ? recordsByKey.get(id) : undefined;
  if (r) {
    document.title = `${STATUS_GLYPH[r.status] ?? ""} ${nodeTitle(r)} · agent-yes`.trim();
  } else {
    const n = recordsByKey.size;
    document.title = n ? `agent-yes · rgui · ${n} agents` : "agent-yes · rgui — live agent tree";
  }
}

// ── system status palette (screen-fixed rgui Panel) ──────────────────────────
// A viewport-anchored panel — it never zooms or pans with the world, unlike the
// info card. Shows the fleet at a glance: live/total agents (title) + a
// per-status breakdown (items). Drag its header and rgui snaps it to the
// viewport edges / other panels; onPanelMove persists the anchor across reloads.
const SYS_PANEL_KEY = "rgui-syspanel-anchor";
const PIN_PANEL_KEY = "rgui-pinpanel-anchor";
function loadPanelAnchor(key: string, dflt: Panel["anchor"]): Panel["anchor"] {
  try {
    const raw = localStorage.getItem(key);
    if (raw === "left" || raw === "right") return raw;
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p.x === "number" && typeof p.y === "number") return p;
    }
  } catch {
    /* corrupt stored anchor — fall through to the default edge */
  }
  return dflt;
}
const sysPanel: Panel = { id: "sys", title: "agents", anchor: loadPanelAnchor(SYS_PANEL_KEY, "right"), w: 200, items: [] };
const STATUS_ROWS: [AgentStatus, string][] = [
  ["active", "active"],
  ["needs_input", "waiting"],
  ["stuck", "stuck"],
  ["idle", "idle"],
  ["exited", "exited"],
];
// Recompute the panel's headline + rows from the current record set and redraw.
function updateSysPanel(records: AgentRecord[], live: boolean) {
  const counts = new Map<AgentStatus, number>();
  const cwds = new Set<string>();
  const repos = new Set<string>();
  for (const r of records) {
    counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
    cwds.add(r.cwd);
    repos.add(repoOf(r.cwd).key);
  }
  const total = records.length;
  const alive = total - (counts.get("exited") ?? 0);
  sysPanel.title = `${alive} / ${total} agents`;
  // label on the left, count right-aligned via PanelItem.value (rgui renders the
  // value column and clips the label so it never runs under the number).
  const items: PanelItem[] = [];
  for (const [st, label] of STATUS_ROWS) {
    const n = counts.get(st) ?? 0;
    if (n) items.push({ id: st, label, value: String(n), color: DOT_COLOR[st] });
  }
  if (repos.size) {
    items.push({ id: "repos", label: "repos", value: String(repos.size) });
    items.push({ id: "worktrees", label: "worktrees", value: String(cwds.size) });
  }
  // one load row per machine whose /api/host answered (multi-source fleet)
  for (const w of wires.values()) {
    const h = w.hostInfo;
    if (!h?.loadavg?.some((n) => n > 0)) continue;
    const load1 = h.loadavg[0]!;
    items.push({
      id: `load:${w.id}`,
      label: `${h.host} load`,
      value: load1.toFixed(1),
      // saturated host (1-min load past the core count) = the wedged-fleet smell
      color: load1 > h.cpus ? "#f85149" : undefined,
    });
  }
  const liveW = [...wires.values()].filter(wireReady);
  items.push({
    id: "conn",
    label: live
      ? `live · ${liveW.length} source${liveW.length === 1 ? "" : "s"}`
      : "demo · no ay serve",
    color: live ? "#3fb950" : "#d29922",
  });
  sysPanel.items = items;
  applyPanels();
}

// ── pinned-agents palette (screen-fixed, shared with the /w/ console) ─────────
// Pins live in the same localStorage set the console's left-panel pin uses
// (ay.pinned, keyed by agent _key). Each pinned agent that's present in the
// current fleet shows as a row in a screen-fixed palette; clicking a row glides
// the camera to that node. Pin/unpin happens via a node's right-click menu (here)
// or the console list (there) — a storage event keeps the two views in sync.
const AY_PINNED_KEY = "ay.pinned";
function loadPinnedKeys(): Set<string> {
  try {
    const a = JSON.parse(localStorage.getItem(AY_PINNED_KEY) || "[]");
    return new Set(Array.isArray(a) ? a : []);
  } catch {
    return new Set();
  }
}
let pinnedKeys = loadPinnedKeys();
function isPinned(id: string): boolean {
  return pinnedKeys.has(id);
}
function togglePin(id: string): void {
  if (pinnedKeys.has(id)) pinnedKeys.delete(id);
  else pinnedKeys.add(id);
  try {
    localStorage.setItem(AY_PINNED_KEY, JSON.stringify([...pinnedKeys]));
  } catch {
    /* storage unavailable — pin just won't persist / sync */
  }
  updatePinPanel();
}
const pinPanel: Panel = {
  id: "pins",
  title: "📌 pinned",
  // Right edge (like sysPanel) — the top-left is occupied by the page's own
  // toolbar/legend chrome, which would hide a left-anchored panel.
  anchor: loadPanelAnchor(PIN_PANEL_KEY, "right"),
  w: 200,
  items: [],
  onItemClick: (item) => focusNode(item.id),
};
// The pin palette is only shown when something is pinned; sysPanel is always on.
function applyPanels(): void {
  viewer.setPanels(pinnedKeys.size ? [pinPanel, sysPanel] : [sysPanel]);
}
// Rebuild the pin palette rows from the current fleet (skip pins whose agent
// isn't in view — another machine, or exited-and-gone).
function updatePinPanel(): void {
  const items: PanelItem[] = [];
  for (const id of pinnedKeys) {
    const r = recordsByKey.get(id);
    if (!r) continue;
    items.push({ id, label: nodeTitle(r), value: String(r.pid), color: DOT_COLOR[r.status] });
  }
  pinPanel.items = items;
  pinPanel.title = items.length ? `📌 pinned · ${items.length}` : "📌 pinned";
  applyPanels();
}

// ── bootstrap ────────────────────────────────────────────────────────────────
const canvas = document.getElementById("viewer") as HTMLCanvasElement;
const debug = document.getElementById("debug");
const statusEl = document.getElementById("status")!;
const statusLabel = statusEl.querySelector(".label")!;

const initialTheme = (document.documentElement.dataset.theme as "dark" | "light") ?? "dark";

const viewer: Rgui = createRgui(canvas, {
  graph: { nodes: [], edges: [] },
  theme: initialTheme,
  debug,
  panels: [sysPanel],
  onPanelMove: (p, anchor) => {
    // persist the dragged/snapped anchor so each palette stays where the user left it
    try {
      localStorage.setItem(p.id === "pins" ? PIN_PANEL_KEY : SYS_PANEL_KEY, JSON.stringify(anchor));
    } catch {
      /* storage unavailable — position just won't persist */
    }
  },
  onNodeClick: (id) => {
    // focus the clicked agent — a real hook point for "open this agent's console"
    viewer.setSelection([id]);
  },
  onNodeContextMenu: (id, screen) => {
    // right-click → batch-send to the selection (or just this node); a selected
    // container expands to its agent descendants. Environment-ish nodes (host
    // env / cwd / repo) additionally offer "spawn here" — the env node as a
    // launch target (the textarea doubles as the new agent's prompt).
    const sel = viewer.selection;
    const base = sel.includes(id) && sel.length > 0 ? [...sel] : [id];
    if (!sel.includes(id)) viewer.setSelection(base);
    const set = new Set<string>();
    for (const t of base) {
      if (recordsByKey.has(t)) set.add(t);
      else for (const d of agentDescendants(t)) set.add(d);
    }
    const targets = [...set];
    const spawn = spawnSpecOf(id);
    if (targets.length || spawn) openBatchMenu(screen.x, screen.y, targets, spawn);
  },
  onSelectionChange: () => {
    updateNodeDebug();
    updateDocTitle(); // tab title follows the selected agent
    persistSelection(); // /w/ ⇄ /r/ focus sync: same ay.sel + #room:pid the console keeps
  },
  onNodeResizeEnd: (id, size) => {
    // remember a shift+drag magnify (scale ≠ 1) so it persists across rebuilds;
    // a reset back to 1 drops it. (Plain reflow resize isn't persisted.)
    if (size.scale && Math.abs(size.scale - 1) > 0.01) scaleByNode.set(id, size.scale);
    else scaleByNode.delete(id);
  },
  onFrame: (view) => {
    updateNodeDebug(); // selected node's screen rect tracks pan/zoom every frame
    const now = Date.now();
    if (view.k !== prevK || view.x !== prevX || view.y !== prevY) {
      prevK = view.k;
      prevX = view.x;
      prevY = view.y;
      lastViewChangeAt = now;
      return; // mid-gesture: leave terminals exactly as they are (rgui scales them)
    }
    // view is momentarily still — only reconcile once it has settled
    if (now - lastViewChangeAt < SETTLE_MS) return;
    if (now - lastTermSync < 200) return;
    lastTermSync = now;
    syncTerminals(view);
  },
});

// expose for e2e/debugging (harmless): window.__rgui.viewer / .lastRecords
(window as unknown as { __rgui: unknown }).__rgui = {
  viewer,
  get graph() {
    return viewer.graph;
  },
  wires, // e2e/debug: per-source transport state (multi-room merge)
  scaleByNode, // e2e/debug: inspect persisted magnify
  // e2e: force a structural rebuild THROUGH the real path (setGraph + magnify restore)
  rebuild: () => {
    viewer.setGraph(buildGraph([...recordsByKey.values()]));
    reapplyMagnify();
  },
};

// Fit all agents, but never zoom out past a readable scale — a full forest fit
// otherwise lands so far out that rgui's semantic-zoom LOD collapses the
// edge-less, spread-out nodes below the draw threshold and the canvas looks
// empty. Below MIN_FIT_K we hold MIN_FIT_K and keep the forest centered; the
// user pans to explore (and zooms out further on purpose to renormalize).
const MIN_FIT_K = 0.42;
function fitReadable(pad = 80) {
  viewer.fitView(pad);
  const v = viewer.view;
  if (v.k >= MIN_FIT_K) return;
  const cw = canvas.clientWidth || window.innerWidth;
  const ch = canvas.clientHeight || window.innerHeight;
  const wcx = (cw / 2 - v.x) / v.k;
  const wcy = (ch / 2 - v.y) / v.k;
  const k = MIN_FIT_K;
  viewer.setView({ k, x: cw / 2 - wcx * k, y: ch / 2 - wcy * k });
}

// The 43 live agents flip status/title constantly. A full setGraph re-layouts
// and reshuffles every node (jumping them out from under the view and dropping
// terminals), so split the record set into two signatures:
//  - STRUCTURE (pid set + parent tree): a change here needs a real relayout.
//  - CONTENT (status/title/branch/question): update the existing nodes IN PLACE
//    and redraw — positions and terminals stay put.
function structureSig(records: AgentRecord[]): string {
  return records
    .map((r) => `${r._key}>${r.parent_pid ?? ""}`)
    .sort()
    .join("|");
}
function contentSig(records: AgentRecord[]): string {
  return records
    .map((r) => `${r._key}:${r.status}:${r.question ?? ""}:${r.title ?? ""}:${r.git?.branch ?? ""}`)
    .sort()
    .join("|");
}

let firstPaint = true;
let liveKnown = false;
let lastStruct = "";
let lastContent = "";

// Refresh title/category/fields on the existing nodes (+ terminal title bars)
// in place. We deliberately DON'T force a redraw here: a `setGraph` per poll
// re-renders the whole canvas AND kicks rgui's frame-animation loop, which
// re-glues every overlay for ~1-2s — the visible "flashing" every few seconds.
// The mutated fields are picked up by the next natural frame (any pan/zoom), and
// the cards are only readable when zoomed out anyway; the live terminals (the
// thing you watch up close) update themselves via their own streams, and their
// title bars/status dots are refreshed cheaply below.
function updateContent(records: AgentRecord[]) {
  const byId = new Map(records.map((r) => [r._key, r] as const));
  for (const n of viewer.graph.nodes) {
    const r = byId.get(n.id);
    if (r) {
      const fresh = nodeOf(r);
      n.title = fresh.title;
      n.category = fresh.category;
      n.fields = fresh.fields;
      n.outputs = fresh.outputs; // status/ask/result track live state (no relayout)
    } else if (cwdGroups.has(n.id)) {
      // same-cwd container: recompute the shared (loudest) state in place
      n.category = `cwd-${aggStateOf(cwdGroups.get(n.id)!)}`;
      n.fields = cwdFields(cwdGroups.get(n.id)!);
    } else if (n.id.startsWith("env:")) {
      n.fields = hostEnvFields(n.id.slice(4)); // live/stuck counts track the fresh records
    }
  }
  for (const [pid, e] of terms) {
    const r = byId.get(pid);
    if (!r) continue;
    const t = e.el.querySelector<HTMLElement>(".t");
    if (t) t.textContent = nodeTitle(r);
    const dot = e.el.querySelector<HTMLElement>(".dot");
    if (dot) dot.className = `dot ${r.status}`;
  }
}

// Restore each remembered user magnify onto the rebuilt nodes via rescaleNode —
// the ratio-preserving path (it scales w and h by the SAME factor and sets
// scale). Setting n.scale alone would leave a base-sized box inconsistent with
// the scale, and a later snapGraph() snaps w/h independently and skews the ratio
// (per rgui's resize-or-scale author).
function reapplyMagnify() {
  if (!scaleByNode.size) return;
  const present = new Set(viewer.graph.nodes.map((n) => n.id));
  for (const [id, s] of scaleByNode) if (present.has(id)) viewer.rescaleNode(id, s);
}

// ── federated mirrors (#feed=<url>[&feed=…] · #feddemo) ──────────────────────
// Read-only subgraphs from OTHER rgui hosts (otoji.org etc.), as
// org.rgui.graph.v1 envelopes (lib/rgui src/core/federation.ts). Each feed is
// polled, converted via federatedGraphToRgui (clamped, remote:true = read-only
// mirror) and merged under the local forest. Merge is id-based: the local graph
// wins, then feeds in listed order — a feed carrying a STUB of another system's
// node (e.g. otoji referencing ay://agent-yes/codex-agent) dedupes away when the
// authoritative node is present, and its cross-system edges land on the real one.
const FED_Y0 = 900; // world-y where the first federated subgraph mounts
const FED_GAP = 300; // vertical gap between stacked federated subgraphs
const fedHashParts = hashParts;
const fedFeeds = fedHashParts
  .filter((s) => s.startsWith("feed="))
  .map((s) => decodeURIComponent(s.slice(5)));
const fedDemo = fedHashParts.includes("feddemo");
// feed key -> converted subgraph + the ONE id-scheme that feed may speak for
// (`${producer.app}://`) — producers differ in how they scope origins under the
// app (ay://agent-yes/…, otoji://room/<room>/…), so authority is enforced at
// the app scheme: an otoji feed can never paint ay:// nodes and vice versa.
// null ns = trusted local demo (ships in the bundle, spans all schemes).
const fedGraphs = new Map<string, { g: Graph; ns: string | null }>();
const fedRevisions = new Map<string, string>();
let lastLocalGraph: Graph = { nodes: [], edges: [] };

function mergeFederated(local: Graph): Graph {
  if (!fedGraphs.size) return local;
  const nodes = [...local.nodes];
  const edges = [...local.edges];
  const seen = new Set(nodes.map((n) => n.id));
  // stack subgraphs downward by MEASURED height (a big fleet mirror would
  // otherwise run into the next subgraph); live feeds merge before the baked
  // demo so an authoritative node (e.g. our codex-agent) beats the demo's stub
  let cursor = Math.max(FED_Y0, ...local.nodes.map((n) => n.y + (n.h ?? CARD_H) + FED_GAP));
  for (const key of [...fedFeeds, "demo"]) {
    const entry = fedGraphs.get(key);
    if (!entry?.g.nodes.length) continue;
    // ns enforcement: a feed only ever RENDERS nodes in its own namespace.
    // Foreign-ns entries act as stubs — invisible, but their edges below still
    // land when the authoritative feed provides the real node — so a hostile
    // feed can't paint content as somebody else's agent.
    const ns = entry.ns;
    const g = ns ? { ...entry.g, nodes: entry.g.nodes.filter((n) => n.id.startsWith(ns)) } : entry.g;
    if (!g.nodes.length) continue;
    const minX = Math.min(...g.nodes.map((n) => n.x));
    const minY = Math.min(...g.nodes.map((n) => n.y));
    let maxY = cursor;
    for (const n of g.nodes) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      // clone with translated coords — the cached subgraph stays unshifted so a
      // re-merge (feed update) can't drift it
      const y = n.y - minY + cursor;
      maxY = Math.max(maxY, y + (n.h ?? CARD_H));
      nodes.push({ ...n, x: n.x - minX + 40, y });
    }
    edges.push(...g.edges);
    cursor = maxY + FED_GAP;
  }
  return { nodes, edges: edges.filter((e) => seen.has(e.from.node) && seen.has(e.to.node)) };
}

// Feed edges survive applyEdges' wire rebuild (it truncates graph.edges).
function fedEdges(present: Set<string>): Edge[] {
  const out: Edge[] = [];
  for (const { g } of fedGraphs.values())
    out.push(...g.edges.filter((e) => present.has(e.from.node) && present.has(e.to.node)));
  return out;
}

function refreshFedGraph() {
  viewer.setGraph(mergeFederated(lastLocalGraph));
  reapplyMagnify();
  applyEdges();
}

async function pollFeeds() {
  let changed = false;
  for (let i = 0; i < fedFeeds.length; i++) {
    const url = fedFeeds[i];
    try {
      const env = await (await fetch(url)).json();
      if (!isFederatedGraphEnvelope(env)) continue;
      const rev = String(env.revision);
      if (fedRevisions.get(url) === rev) continue;
      fedRevisions.set(url, rev);
      fedGraphs.set(url, {
        g: federatedGraphToRgui(env, { container: true }),
        ns: `${env.producer.app}://`,
      });
      changed = true;
    } catch {
      /* feed unreachable — keep the last mirror (or none) */
    }
  }
  if (changed) refreshFedGraph();
}
if (fedDemo) {
  // offline showcase: the baked cross-system chain (plaintext → codex-agent →
  // diff → filter → translate → tts) from rgui itself, no feed server needed
  // the baked demo chain intentionally spans all three namespaces — it ships in
  // the bundle (rgui source), not from a network feed, so it merges unenforced
  fedGraphs.set("demo", { g: federatedGraphToRgui(federatedDemoChain(), { container: true }), ns: null });
}
if (fedFeeds.length) {
  void pollFeeds();
  setInterval(() => void pollFeeds(), 5000);
}

function apply(records: AgentRecord[], live: boolean) {
  recordsByKey.clear();
  for (const r of records) recordsByKey.set(r._key, r);
  const struct = structureSig(records);
  const content = contentSig(records);
  if (struct !== lastStruct) {
    lastStruct = struct;
    lastContent = content;
    // tear down terminals for agents that are gone (exited/removed)
    for (const id of [...terms.keys()]) if (!recordsByKey.has(id)) dropTerm(id);
    lastLocalGraph = buildGraph(records);
    viewer.setGraph(mergeFederated(lastLocalGraph));
    markShared();
    reapplyMagnify(); // restore user magnify on the rebuilt nodes (ratio-safe)
    applyEdges(); // rebuild wires on the new node set
    if (firstPaint) {
      fitReadable();
      firstPaint = false;
    }
  } else if (content !== lastContent) {
    lastContent = content;
    updateContent(records);
  }
  liveKnown = live;
  statusEl.className = live ? "live" : "demo";
  const n = records.length;
  const liveW = [...wires.values()].filter(wireReady).length;
  statusLabel.textContent = live
    ? `live · ${n} agent${n === 1 ? "" : "s"}${liveW > 1 ? ` · ${liveW} sources` : usingRoom() ? " (room)" : ""}`
    : "demo · no local ay serve";
  updateSysPanel(records, live); // refresh the screen-fixed status palette
  updatePinPanel(); // refresh the pinned-agents palette (fleet may have changed)
  updateDocTitle(); // keep the tab title's name/status/count fresh
}

// Rebuild the relationship wires (read/tail edges between present agent nodes) on
// the current graph and redraw — cheap, no relayout. Called on structure change,
// the edge poll, and the wire toggle.
function applyEdges() {
  const present = new Set(viewer.graph.nodes.map((n) => n.id));
  const edges: Edge[] = showWires
    ? readEdges
        .filter((e) => e.by !== e.target && present.has(e.by) && present.has(e.target))
        // "by read target" is a dataflow: the watched agent's `status` output
        // feeds the reader's `deps` input (Y.status → X.deps), so the arrow
        // points the way the information actually travels.
        .map((e) => ({
          from: { node: e.target, port: "status" },
          to: { node: e.by, port: "deps" },
          dashed: true,
          style: { color: "#58a6ff", width: 1.5, dash: [6, 4] },
        }))
    : [];

  // Send wires point the way the MESSAGE travels: the sender drives the
  // recipient's `prompt` input (the port that models "what you `ay send` it").
  // Opposite direction from a read wire, which follows the information flowing
  // BACK to the reader — so a two-way exchange reads as two arrows, not one.
  // Alpha decays with age (see sendAlpha); a key/select event is styled apart
  // from a text message since it's a keystroke, not a prompt.
  const sends: Edge[] = showWires
    ? sendEdges
        .filter((e) => e.by !== e.target && present.has(e.by) && present.has(e.target))
        .flatMap((e) => {
          const a = sendAlpha(e.at);
          if (a <= 0) return [];
          const rgb = e.kind ? "245, 158, 11" : "63, 185, 80"; // amber = key/select, green = message
          return [
            {
              from: { node: e.by, port: "status" },
              to: { node: e.target, port: "prompt" },
              dashed: true,
              label: e.kind ?? "msg",
              style: {
                color: `rgba(${rgb}, ${(0.25 + 0.75 * a).toFixed(3)})`,
                // fresh sends read as a thicker, brighter wire that thins as it fades
                width: 1.5 + 2 * a,
                dash: [2, 3],
              },
            } satisfies Edge,
          ];
        })
    : [];

  viewer.graph.edges.length = 0;
  // env wires are structural (host → its top-level groups), not toggled with
  // the read/tail wires — always drawn, and few (one per root)
  viewer.graph.edges.push(
    ...edges,
    ...sends,
    ...envEdges.filter((e) => present.has(e.from.node) && present.has(e.to.node)),
    ...fedEdges(present),
  );
  viewer.setView(viewer.view); // schedule a redraw without a relayout
}

type EdgesResponse = {
  reads?: { by: number; target: number; at: number }[];
  sends?: { by: number; target: number; at: number; kind?: "key" | "select" }[];
};

async function fetchEdges() {
  const results = await Promise.allSettled(
    [...wires.values()].filter(wireReady).map(async (w) => {
      const body = await apiJSON<EdgesResponse>("/api/edges", w.id);
      const key = (pid: number) => `${w.id}#${pid}`;
      return {
        reads: (body.reads ?? []).map((e) => ({
          by: key(e.by),
          target: key(e.target),
          at: e.at,
        })),
        // `sends` is absent on an older daemon — the send wires just stay empty.
        sends: (body.sends ?? []).map((e) => ({
          by: key(e.by),
          target: key(e.target),
          at: e.at,
          kind: e.kind,
        })),
      };
    }),
  );
  const ok = results.flatMap((p) => (p.status === "fulfilled" ? [p.value] : []));
  const reads = ok.flatMap((r) => r.reads);
  const sends = ok.flatMap((r) => r.sends);
  if (reads.length || readEdges.length || sends.length || sendEdges.length) {
    readEdges = reads;
    sendEdges = sends;
    applyEdges();
    ensureSendFadeTicker();
  }
}

// Poll each wire's host environment (identity + load/mem/caps) every 30s. A
// first answer adds that machine's env node to the forest (structure change →
// force a rebuild); later answers only refresh its fields in place — same
// no-flash philosophy as updateContent. A 404 (older daemon) = no env node.
async function fetchHosts() {
  let firstArrival = false;
  await Promise.allSettled(
    [...wires.values()].filter(wireReady).map(async (w) => {
      try {
        let h: HostInfo;
        try {
          h = await apiJSON<HostInfo>("/api/host", w.id);
        } catch {
          // older daemon without /api/host — fall back to /api/whoami (ancient)
          // for a bare-identity env node: the machine still deserves its ⬢.
          const who = await apiJSON<{ host: string }>("/api/whoami", w.id);
          h = {
            host: who.host,
            platform: "",
            arch: "",
            cpus: 0,
            loadavg: [],
            mem: { total: 0, free: 0 },
            uptime: 0,
          };
        }
        if (!w.hostInfo) firstArrival = true;
        w.hostInfo = h;
        // Best-effort: refresh this machine's active exposures for the env node.
        try {
          const ex = await apiJSON<ExposureInfo[]>("/api/exposes", w.id);
          if (Array.isArray(ex)) exposedBySrc.set(w.id, ex);
        } catch {
          /* older daemon without /api/exposes — no exposed row */
        }
        const n = viewer.graph.nodes.find((x) => x.id === envIdOf(w.id));
        if (n) n.fields = hostEnvFields(w.id); // picked up by the next natural frame
      } catch {
        /* both unavailable (static host / wire down) */
      }
    }),
  );
  if (firstArrival) {
    lastStruct = ""; // new env node joins the graph on the next apply()
    void refresh();
  }
}
setInterval(() => void fetchHosts(), 30_000);

async function refresh() {
  const ws = [...wires.values()];
  const results = await Promise.allSettled(
    ws.map(async (w) => {
      const recs = await apiJSON<AgentRecord[]>("/api/ls", w.id);
      if (w.kind === "http") w.connected = true; // reachable — count it as a source
      return recs.map((r) => ({ ...r, _src: w.id, _key: `${w.id}#${r.pid}` }));
    }),
  );
  // an http wire that failed is not a source (static host / daemon down)
  ws.forEach((w, i) => {
    if (w.kind === "http" && results[i]!.status === "rejected") w.connected = false;
  });
  const merged = results.flatMap((p) => (p.status === "fulfilled" ? p.value : []));
  if (results.some((p) => p.status === "fulfilled")) {
    apply(merged, true);
    void fetchEdges();
    void fetchShares();
    focusPendingSelection(); // ay.sel / #room:pid focus once its node exists
  } else if (!liveKnown && ![...wires.values()].some((w) => w.kind === "rtc")) {
    // nothing to connect to at all (static preview, no rooms known) — show the
    // sample forest; with rooms configured we show their connection state instead
    apply(sampleRecords(), false);
  }
}

// ── wire boot: hash share link + every /w/-cached room + local HTTP ──────────
// Each rtc wire keeps itself alive with jittered exponential backoff — a
// dropped DataChannel (host restart) otherwise leaves that source dead until a
// manual reload. Mirrors the console's connectRtcSource lifecycle.
function addRtcWire(roomName: string, token: string, sigHost: string) {
  if (wires.has(roomName)) return;
  const w: Wire = {
    id: roomName,
    kind: "rtc",
    sigHost: sigHost || "s.agent-yes.com",
    token,
    client: null,
    connected: false,
    hostInfo: null,
  };
  wires.set(roomName, w);
  const RTC_MIN = 1000;
  const RTC_MAX = 30000;
  let delay = RTC_MIN;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void connectOnce();
    }, delay);
    delay = Math.min(RTC_MAX, delay * 2) + Math.floor(Math.random() * 500);
  };
  async function connectOnce() {
    // Drop any stale peer first, detaching its onstate so its own "closed" can't
    // re-arm a reconnect mid-replace (which would churn a healthy channel).
    if (w.client) {
      (w.client as { onstate?: (st: string) => void }).onstate = () => {};
      try {
        w.client.close();
      } catch {
        /* */
      }
      w.client = null;
    }
    w.connected = false;
    if (!liveKnown && usingRoom() && roomInfo!.room === w.id) {
      statusEl.className = "demo";
      statusLabel.textContent = "connecting room…";
    }
    try {
      const c = new RTCClient(w.sigHost, w.id, w.token) as InstanceType<typeof RTCClient> & {
        onstate: (st: string) => void;
      };
      c.onstate = (st: string) => {
        // "disconnected" is transient (ICE hiccup) — only a real teardown reconnects.
        if (st === "failed" || st === "closed") {
          w.connected = false;
          schedule();
        }
      };
      await c.connect();
      w.client = c;
      w.connected = true;
      delay = RTC_MIN; // a healthy connect resets the backoff
      lastStruct = ""; // this source's agents join the forest on the next apply
      void refresh(); // pull the first snapshot over the wire immediately
      void fetchHosts(); // and its host env (the 30s interval keeps it fresh)
    } catch {
      schedule();
    }
  }
  void connectOnce();
}

// ── embed mode: ONE agent's live terminal, full viewport (renderHints.embed) ──
// No forest, no polling loops — just the raw tail into an xterm sized to the
// agent's native PTY grid, scaled down to fit the (usually iframe) viewport.
function initEmbed(pid: string) {
  document.title = `agent-yes · #${pid}`;
  // the forest page booted underneath — drop its chrome entirely (incl. chrome
  // mounted LATER, e.g. the theme toggle); the embed IS the whole document now
  const css = document.createElement("style");
  css.textContent = "body.ay-embed > *:not(.ay-embed-wrap){display:none!important}";
  document.head.appendChild(css);
  document.body.classList.add("ay-embed");
  const wrap = document.createElement("div");
  wrap.className = "ay-embed-wrap";
  wrap.style.cssText = "position:fixed;inset:0;z-index:99;background:#0d1117;overflow:hidden";
  const inner = document.createElement("div");
  inner.style.cssText = "transform-origin:0 0"; // scaled to fit; wrap bg stays full-viewport
  wrap.appendChild(inner);
  document.body.appendChild(wrap);
  if (!XTermCtor) {
    wrap.textContent = "xterm failed to load";
    return;
  }
  const term = new XTermCtor({
    fontSize: 14,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    theme: termTheme(),
    disableStdin: true, // read-only mirror, same as the forest terminals
    cursorBlink: false,
    scrollback: 1000,
    convertEol: false,
  });
  term.open(inner);
  // scale the native-grid terminal to FIT the viewport (never upscale) — the
  // iframe consumer sizes us to the node rect, so this is the whole fit story
  const fit = () => {
    const el = inner.querySelector(".xterm") as HTMLElement | null;
    if (!el || !el.offsetWidth || !el.offsetHeight) return;
    // wrap, not window: the prompt bar (below) carves its height off the wrap
    const s = Math.min(1, wrap.clientWidth / el.offsetWidth, wrap.clientHeight / el.offsetHeight);
    inner.style.transform = `scale(${s})`;
  };
  addEventListener("resize", fit);
  apiJSON<{ cols?: number; rows?: number }>(`/api/size/${encodeURIComponent(pid)}`)
    .then((sz) => {
      if (sz?.cols && sz?.rows) term.resize(sz.cols, sz.rows);
    })
    .catch(() => {})
    .finally(() => requestAnimationFrame(fit));
  subscribeRaw(`/api/tail/${encodeURIComponent(pid)}?raw=1`, (d) => term.write(d as string));
  // direct typing: the embed IS the terminal, so stdin is armed from the start
  // (&ro keeps it read-only); click the page and type
  if (!hashParts.includes("ro")) {
    term.options.disableStdin = false;
    term.options.cursorBlink = true;
    // the embed is served by the agent's own daemon (#k= auth) — local wire
    attachStdin(term, `${LOCAL}#${pid}`, () => {
      document.title = `agent-yes · #${pid} (read-only)`;
    });
  }

  // Prompt bar: the WRITE half of the embed. The #k= token that authorizes the
  // tail stream authorizes /api/send just the same, so an embed holder can talk
  // to the agent — this is federation's spec'd mutation path ("writes go
  // through the publisher's own API with its own auth", rgui docs/federation.md).
  // Append &ro to the embed URL for a strictly read-only view.
  if (hashParts.includes("ro")) return;
  const BAR_H = 36;
  wrap.style.bottom = `${BAR_H}px`;
  const bar = document.createElement("form");
  bar.className = "ay-embed-wrap"; // survives the chrome-hiding CSS above
  bar.style.cssText =
    `position:fixed;left:0;right:0;bottom:0;height:${BAR_H}px;z-index:100;display:flex;gap:6px;` +
    "align-items:center;padding:0 8px;background:#161b22;border-top:1px solid #30363d";
  const input = document.createElement("input");
  input.placeholder = `send to #${pid} — Enter ↵`;
  input.style.cssText =
    "flex:1;height:24px;background:#0d1117;color:#c9d1d9;border:1px solid #30363d;" +
    "border-radius:5px;padding:0 8px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;outline:none";
  const state = document.createElement("span");
  state.style.cssText = "font:11px ui-monospace,monospace;color:#8b949e;min-width:16px";
  bar.append(input, state);
  document.body.appendChild(bar);
  bar.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = input.value.trim();
    if (!msg) return;
    state.textContent = "…";
    const r = await apiPost("/api/send", { keyword: pid, msg, code: "enter" });
    state.textContent = r.ok ? "✓" : "✗";
    state.title = r.ok ? "" : r.text;
    if (r.ok) input.value = "";
    setTimeout(() => (state.textContent = ""), 1500);
  });
}

if (embedMode) {
  // the embed talks to its own serving daemon only — one local wire
  wires.set(LOCAL, {
    id: LOCAL,
    kind: "http",
    sigHost: "",
    token: "",
    client: null,
    connected: true,
    hostInfo: null,
  });
  initEmbed(embedPid!);
} else {
  // Boot the wires: the local daemon + the hash room (if any) + EVERY room the
  // console has cached (ay.rooms) — /w/ and /r/ are two UIs over one fleet.
  wires.set(LOCAL, {
    id: LOCAL,
    kind: "http",
    sigHost: "",
    token: "",
    client: null,
    connected: true, // optimistic; refresh() flips it on the first failed /api/ls
    hostInfo: null,
  });
  if (roomInfo) addRtcWire(roomInfo.room, roomInfo.token, roomInfo.host);
  for (const [name, r] of Object.entries(loadRooms()))
    if (r?.token) addRtcWire(name, r.token, r.host || "s.agent-yes.com");
  refresh();
  setInterval(refresh, 3000);
  void fetchHosts();
}
// The whole page is configured from the hash (room / feeds / embed target / k=),
// all read once at boot — a hash-only navigation (e.g. an iframe consumer
// swapping #node=) must re-boot, not silently keep the old wiring.
addEventListener("hashchange", () => location.reload());

// QA (#qa): auto-zoom into a leaf so terminals spawn (the size probe in makeTerm
// then logs each overlay's px), and run a slow zoom sweep logging how many times
// the overlay layer toggles visibility — the "flash" signal — since rech's
// idle-wait can't eval a page holding live SSE streams.
if (location.hash.startsWith("#qa")) {
  setTimeout(() => {
    const parents = new Set(viewer.graph.nodes.map((n) => n.parent).filter(Boolean));
    const leaf = viewer.graph.nodes.filter((n) => !parents.has(n.id) && !n.id.startsWith("repo:"))[6];
    if (!leaf) return;
    const cx = leaf.x + leaf.w / 2;
    const cy = leaf.y + (leaf.h ?? CARD_H) / 2;
    // The flash signal is a canvas REPAINT while the view is scaling. Count xterm
    // content mutations that land WHILE the view is moving — with the defer-writes
    // fix this should be ~0 even though stream bytes keep arriving (they're
    // buffered). Also count overlay display-toggles + ay-term churn for good measure.
    let xtermMutWhileMoving = 0;
    let displayToggles = 0;
    let termChurn = 0;
    const mutSample = new Set<string>();
    const seenDisplay = new WeakMap<Element, string>();
    const moving = () => Date.now() - lastViewChangeAt < SETTLE_MS;
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        const t = m.target as Element;
        if (t.closest?.(".xterm")) {
          if (moving()) {
            xtermMutWhileMoving++;
            const el = (t.nodeType === 3 ? t.parentElement : t) as Element;
            if (mutSample.size < 8)
              mutSample.add(`${m.type}:${el?.tagName?.toLowerCase()}.${(el?.className || "").toString().slice(0, 24)}`);
          }
        } else if (m.type === "childList") {
          for (const n of m.addedNodes) if ((n as Element).classList?.contains("ay-term")) termChurn++;
          for (const n of m.removedNodes) if ((n as Element).classList?.contains("ay-term")) termChurn++;
        } else if (m.type === "attributes" && m.attributeName === "style") {
          const el = m.target as HTMLElement;
          const d = el.style.display;
          if (seenDisplay.get(el) !== d && (d === "none" || d === "")) {
            if (seenDisplay.has(el)) displayToggles++;
            seenDisplay.set(el, d);
          }
        }
      }
    });
    // 1) zoom in and hold, so terminals actually spawn (the settle-gate blocks
    //    creation during motion) and start streaming.
    const k0 = 1.9;
    viewer.setView({ k: k0, x: innerWidth / 2 - cx * k0, y: innerHeight / 2 - cy * k0 });
    setTimeout(() => {
      // 2) now WIGGLE the zoom (continuous motion) while terminals stream, and
      //    measure xterm repaints landing mid-motion — the flash.
      obs.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
        attributeFilter: ["style"],
      });
      const deferBase = deferredWhileMoving;
      let t = 0;
      const iv = setInterval(() => {
        t++;
        const k = k0 * (1 + 0.18 * Math.sin(t * 0.6)); // oscillate around k0 (stays zoomed)
        viewer.setView({ k, x: innerWidth / 2 - cx * k, y: innerHeight / 2 - cy * k });
        if (t > 30) {
          clearInterval(iv);
          setTimeout(() => {
            obs.disconnect();
            console.log(
              `[rgui-qa] zoom-wiggle: xterm-repaints-while-moving=${xtermMutWhileMoving} (THE FLASH — want ~0), ` +
                `stream-bytes-deferred=${deferredWhileMoving - deferBase} (>0 proves streams were live during motion), ` +
                `display-toggles=${displayToggles}, ay-term churn=${termChurn}, ` +
                `mut-sample=[${[...mutSample].join(", ")}]`,
            );
          }, 400);
        }
      }, 90);
    }, 1800);
  }, 3500);
}

// Reconcile terminals on a steady tick too — onFrame alone can starve (a single
// settle frame that lands inside the throttle window is skipped and never
// retried until the next interaction), so this guarantees convergence to the
// current view whether or not frames are flowing. Also gated on the view being
// settled, so a zoom in progress never opens/closes streams mid-gesture.
setInterval(() => {
  if (Date.now() - lastViewChangeAt >= SETTLE_MS) {
    syncTerminals(viewer.view);
    // flush stream bytes that were deferred during the gesture (one repaint now,
    // on a settled/non-scaling canvas — no flash)
    for (const [id, e] of terms) {
      if (e.buf) {
        e.term.write(e.buf);
        e.buf = "";
      }
      captureSnapshot(id, e); // keep a fresh thumbnail for the zoomed-out LOD
    }
  }
  updateNodeDebug(); // refresh overlay rect once a terminal spins up after settle
}, 350);

// ── focus a single node ───────────────────────────────────────────────────────
// node focus: fit the view to one node (center + zoom, capped). overlay focus:
// the same, then focus the node's live terminal so you can scroll/select it.
function focusNode(id: string, overlay = false) {
  const n = viewer.graph.nodes.find((x) => x.id === id);
  if (!n) return;
  const h = nodeHeight(n);
  const cw = canvas.clientWidth || innerWidth;
  const ch = canvas.clientHeight || innerHeight;
  const pad = 90;
  const k = Math.min((cw - 2 * pad) / n.w, (ch - 2 * pad) / h, 2.6); // fit node, cap zoom-in
  // glide, don't hard-switch — the camera travel keeps spatial context (taku)
  viewer.setView(
    { k, x: cw / 2 - (n.x + n.w / 2) * k, y: ch / 2 - (n.y + h / 2) * k },
    { animate: true },
  );
  viewer.setSelection([id]);
  if (!overlay) return;
  // the terminal spawns on settle (settle-gate) — poll for it, then focus it.
  let tries = 14;
  const grab = () => {
    const e = terms.get(id);
    if (e) {
      for (const other of terms.values()) other.el.classList.remove("ay-term-focused");
      e.el.classList.add("ay-term-focused");
      try {
        (e.term as unknown as { focus?: () => void }).focus?.();
      } catch {
        /* read-only xterm may not focus — the ring still marks it */
      }
    } else if (--tries > 0) setTimeout(grab, 130);
  };
  setTimeout(grab, 280);
}

// ── /w/ ⇄ /r/ selection sync ─────────────────────────────────────────────────
// The console persists its open agent in localStorage["ay.sel"] as `<src>#<pid>`
// and deep-links as #<room>:<pid> — /r/ speaks BOTH: on boot it focuses the
// deep-linked or last-selected agent once its node exists; on every selection
// it writes ay.sel back in the console's format, so switching /r/ → /w/ lands
// on the same agent. A storage event (the console selecting in another tab)
// follows live.
const SEL_KEY = "ay.sel";
// console key forms: "local#pid" · "<room>#pid" · "<room>/<peer>#pid" (codehost
// rooms name a machine) — normalize the machine part away; our wires are rooms.
function normalizeSelKey(s: string | null): string | null {
  if (!s) return null;
  const i = s.indexOf("#");
  if (i <= 0) return null;
  return `${s.slice(0, i).split("/")[0]}#${s.slice(i + 1)}`;
}
let pendingSel: string | null = (() => {
  const h = decodeURIComponent(String(location.hash || "").replace(/^#/, ""));
  const m = /^([A-Za-z0-9_-]+):(\d{1,7})$/.exec(h);
  if (m) return `${m[1]}#${m[2]}`; // explicit deep link wins
  try {
    return normalizeSelKey(localStorage.getItem(SEL_KEY));
  } catch {
    return null;
  }
})();
function focusPendingSelection() {
  if (!pendingSel) return;
  if (!recordsByKey.has(pendingSel)) return; // that source hasn't merged yet — retry next refresh
  const key = pendingSel;
  pendingSel = null;
  focusNode(key, true);
}
function persistSelection() {
  const key = viewer.selection.find((id: string) => recordsByKey.has(id));
  if (!key) return;
  try {
    localStorage.setItem(SEL_KEY, key);
  } catch {
    /* private mode — the deep-link hash below still carries the selection */
  }
  // mirror the console's #<room>:<pid> deep-link hash (replaceState does NOT
  // fire hashchange, so this never trips the reload-on-hashchange boot rule)
  const r = recordsByKey.get(key)!;
  try {
    const want = r._src === LOCAL ? "" : `#${encodeURIComponent(r._src)}:${r.pid}`;
    if (want && location.hash !== want)
      history.replaceState(null, document.title, location.pathname + want);
  } catch {
    /* */
  }
}
addEventListener("storage", (e) => {
  // pins changed in the console (or another /r/ tab) → resync the palette
  if (e.key === AY_PINNED_KEY) {
    pinnedKeys = loadPinnedKeys();
    updatePinPanel();
    return;
  }
  // live follow: the console (another tab, same origin) opened an agent
  if (e.key !== SEL_KEY) return;
  const key = normalizeSelKey(e.newValue);
  if (key && recordsByKey.has(key) && !viewer.selection.includes(key)) focusNode(key);
});

// ── ⌘K command palette (go to / focus an agent) ───────────────────────────────
const cmdk = document.getElementById("cmdk")!;
const cmdkInput = document.getElementById("cmdk-input") as HTMLInputElement;
const cmdkList = document.getElementById("cmdk-list")!;
const escHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
let cmdkSel = 0;
let cmdkRows: { id: string; title: string; status: string; sub: string }[] = [];

function cmdkData() {
  const rows = [...recordsByKey.values()].map((r) => ({
    id: r._key,
    title: nodeTitle(r),
    status: r.status,
    sub:
      (r._src === LOCAL ? "" : `${r._src} · `) +
      shortCwd(r.cwd) +
      (r.git?.branch ? ` ⎇${r.git.branch}` : ""),
  }));
  rows.sort((a, b) => (a.status === "exited" ? 1 : 0) - (b.status === "exited" ? 1 : 0));
  return rows;
}
function cmdkRender() {
  const q = cmdkInput.value.trim().toLowerCase();
  cmdkRows = cmdkData().filter(
    (r) => !q || `${r.title} ${r.id} ${r.sub} ${r.status}`.toLowerCase().includes(q),
  );
  if (cmdkSel >= cmdkRows.length) cmdkSel = Math.max(0, cmdkRows.length - 1);
  cmdkList.innerHTML = cmdkRows
    .map(
      (r, i) =>
        `<div class="cmdk-row ${i === cmdkSel ? "sel" : ""}" data-i="${i}">` +
        `<span class="dot ${r.status}"></span>` +
        `<span class="cmdk-title">${escHtml(r.title)}</span>` +
        `<span class="cmdk-pid">#${r.id}</span>` +
        `<span class="cmdk-dim">${escHtml(r.sub)}</span></div>`,
    )
    .join("");
  cmdkRows[cmdkSel] && viewer.setSelection([cmdkRows[cmdkSel]!.id]); // preview highlight
  cmdkList.querySelector(".cmdk-row.sel")?.scrollIntoView({ block: "nearest" });
}
function cmdkOpen() {
  cmdk.hidden = false;
  cmdkInput.value = "";
  cmdkSel = 0;
  cmdkRender();
  cmdkInput.focus();
}
function cmdkClose() {
  cmdk.hidden = true;
}
function cmdkGo(overlay: boolean) {
  const r = cmdkRows[cmdkSel];
  if (r) focusNode(r.id, overlay);
  cmdkClose();
}
addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    cmdk.hidden ? cmdkOpen() : cmdkClose();
    return;
  }
  if (cmdk.hidden) return;
  if (e.key === "Escape") (e.preventDefault(), cmdkClose());
  else if (e.key === "ArrowDown") (e.preventDefault(), (cmdkSel = Math.min(cmdkRows.length - 1, cmdkSel + 1)), cmdkRender());
  else if (e.key === "ArrowUp") (e.preventDefault(), (cmdkSel = Math.max(0, cmdkSel - 1)), cmdkRender());
  else if (e.key === "Enter") (e.preventDefault(), cmdkGo(e.metaKey || e.ctrlKey));
});
cmdkInput.addEventListener("input", () => ((cmdkSel = 0), cmdkRender()));
cmdkList.addEventListener("click", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".cmdk-row");
  if (!row) return;
  cmdkSel = Number(row.dataset.i);
  cmdkGo(e.metaKey || e.ctrlKey);
});
cmdk.addEventListener("click", (e) => {
  if (e.target === cmdk) cmdkClose(); // click backdrop to close
});

// ── right-click batch send ────────────────────────────────────────────────────
// agent descendants of a container node (repo/cwd/agent-with-subagents)
function agentDescendants(containerId: string): string[] {
  const parentOf = new Map(viewer.graph.nodes.map((n) => [n.id, n.parent]));
  const out: string[] = [];
  for (const n of viewer.graph.nodes) {
    if (!recordsByKey.has(n.id)) continue;
    let p = n.parent;
    while (p) {
      if (p === containerId) {
        out.push(n.id);
        break;
      }
      p = parentOf.get(p);
    }
  }
  return out;
}

const ctxmenu = document.getElementById("ctxmenu")!;
const ctxInput = document.getElementById("ctx-input") as HTMLTextAreaElement;
let ctxTargets: string[] = [];
let ctxSpawn: { src: string; cwd: string | null; cli: string } | null = null;

// What "spawn here" means for a right-clicked node: an environment-ish node
// (host env / cwd container / repo container) is a launch TARGET — the machine
// AND cwd the new agent starts in; a plain agent spawns a sibling next to
// itself. The cli follows the neighbours, falling back to claude.
// Container ids embed their source: "env:<src>" · "cwd:<src>:<path>" ·
// "repo:<src>:<repoKey>".
function spawnSpecOf(id: string): { src: string; cwd: string | null; cli: string } | null {
  const cliOf = (keys: string[]) => recordsByKey.get(keys[0] ?? "")?.cli ?? "claude";
  if (id.startsWith("env:")) {
    const src = id.slice(4);
    return { src, cwd: null, cli: cliOf([...recordsByKey.values()].filter((r) => r._src === src).map((r) => r._key)) };
  }
  if (id.startsWith("cwd:") || id.startsWith("repo:")) {
    const rest = id.slice(id.indexOf(":") + 1);
    const src = rest.slice(0, rest.indexOf(":"));
    const cwd = rest.slice(rest.indexOf(":") + 1);
    const members = id.startsWith("cwd:") ? (cwdGroups.get(id) ?? []) : agentDescendants(id);
    return { src, cwd, cli: cliOf(members) };
  }
  const r = recordsByKey.get(id);
  return r ? { src: r._src, cwd: r.cwd, cli: r.cli } : null;
}

function openBatchMenu(sx: number, sy: number, pids: string[], spawn: typeof ctxSpawn = null) {
  ctxTargets = pids;
  ctxSpawn = spawn;
  // "share this node" — single agent only (a share scopes to exactly one agent),
  // minted on the agent's OWN daemon: only offered for the local wire (a room
  // viewer holds a share credential, not the host's minting rights).
  ctxSharePid = pids.length === 1 ? pids[0]! : null;
  ctxShare.hidden = !ctxSharePid || srcOf(ctxSharePid ?? "#") !== LOCAL;
  ctxShareOut.hidden = true;
  document.getElementById("ctx-count")!.textContent = String(pids.length);
  document.getElementById("ctx-s")!.textContent = pids.length === 1 ? "" : "s";
  const spawnBtn = document.getElementById("ctx-spawn") as HTMLButtonElement;
  spawnBtn.hidden = !spawn;
  // Pin toggle: single real agent only (a pin targets one agent's node).
  const pinPid = pids.length === 1 && recordsByKey.has(pids[0]!) ? pids[0]! : null;
  const pinBtn = document.getElementById("ctx-pin") as HTMLButtonElement;
  pinBtn.hidden = !pinPid;
  pinBtn.dataset.pid = pinPid ?? "";
  pinBtn.textContent = pinPid && isPinned(pinPid) ? "📌 Unpin" : "📌 Pin";
  if (spawn)
    spawnBtn.title =
      `POST /api/spawn on ${spawn.src === LOCAL ? "this machine" : spawn.src} · ` +
      `${spawn.cli} in ${spawn.cwd ?? "(host default dir)"}`;
  ctxmenu.hidden = false;
  ctxmenu.style.left = `${Math.min(sx, innerWidth - 348)}px`;
  ctxmenu.style.top = `${Math.min(sy, innerHeight - 140)}px`;
  ctxInput.value = "";
  ctxInput.focus();
}
function closeBatchMenu() {
  ctxmenu.hidden = true;
}
async function sendBatch() {
  const msg = ctxInput.value;
  const pids = [...ctxTargets];
  if (!msg.trim() || !pids.length) return closeBatchMenu();
  closeBatchMenu();
  const results = await Promise.allSettled(
    pids.map((key) =>
      apiPost("/api/send", { keyword: pidOf(key), msg }, srcOf(key)).then((r) =>
        r.ok ? r : Promise.reject(r.text),
      ),
    ),
  );
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const prev = statusLabel.textContent;
  statusLabel.textContent = `⌨ sent to ${ok}/${pids.length} agent${pids.length === 1 ? "" : "s"}`;
  setTimeout(() => {
    if (statusLabel.textContent?.startsWith("⌨")) statusLabel.textContent = prev;
    void refresh();
  }, 1500);
}
// Launch a new agent in the right-clicked environment (host env / cwd / repo
// node) — the textarea's content becomes the initial prompt (may be empty).
async function spawnHere() {
  const spec = ctxSpawn;
  if (!spec) return;
  const prompt = ctxInput.value;
  closeBatchMenu();
  statusLabel.textContent = `▷ spawning ${spec.cli}…`;
  const r = await apiPost(
    "/api/spawn",
    {
      cli: spec.cli,
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      prompt,
    },
    spec.src, // launch on the machine that owns the right-clicked environment
  );
  statusLabel.textContent = r.ok ? "▷ spawned" : `spawn failed: ${r.text.slice(0, 80)}`;
  setTimeout(() => void refresh(), 1200);
  setTimeout(() => void refresh(), 4000); // and again once the wrapper registered
}

ctxInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    // Enter = send to the targeted agents; on a pure environment node (no agent
    // targets) there is nothing to send to, so Enter launches instead.
    if (ctxTargets.length) void sendBatch();
    else if (ctxSpawn) void spawnHere();
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeBatchMenu();
  }
  e.stopPropagation();
});
document.getElementById("ctx-send")!.addEventListener("click", () => void sendBatch());
document.getElementById("ctx-spawn")!.addEventListener("click", () => void spawnHere());
document.getElementById("ctx-pin")!.addEventListener("click", () => {
  const pid = (document.getElementById("ctx-pin") as HTMLButtonElement).dataset.pid;
  if (pid) togglePin(pid);
  closeBatchMenu();
});
addEventListener("mousedown", (e) => {
  if (!ctxmenu.hidden && !ctxmenu.contains(e.target as Node)) closeBatchMenu();
});

// ── share this node (right-click menu) ────────────────────────────────────────
// Mints a scoped share via POST /api/share: its own e2ee WebRTC room exposing
// exactly ONE agent, HOST-enforced (default-deny scopedFetch in agentShare.ts),
// 24h TTL. "allow input" = perm rw (holder may send prompts in); output (view)
// is what a share IS. The returned link pastes into any rgui surface — the
// console (/w) opens it directly, /r/#room:… mirrors it — and the shared agent
// gets flagged (node.shared) so rgui can halo it like remote-but-outbound.
const ctxShare = document.getElementById("ctx-share")!;
const ctxShareOut = document.getElementById("ctx-share-out")!;
const ctxShareLink = document.getElementById("ctx-share-link")!;
const ctxSharePerm = document.getElementById("ctx-share-input-perm") as HTMLInputElement;
const ctxShareBtn = document.getElementById("ctx-share-btn") as HTMLButtonElement;
let ctxSharePid: string | null = null;
let sharedIds = new Set<string>(); // agent_ids with an active outbound share
function markShared() {
  let changed = false;
  for (const n of viewer.graph.nodes) {
    const rec = recordsByKey.get(n.id);
    const want = !!rec?.agent_id && sharedIds.has(rec.agent_id);
    const nn = n as { shared?: boolean };
    if ((nn.shared ?? false) !== want) {
      nn.shared = want;
      changed = true;
    }
  }
  if (changed) viewer.setView(viewer.view); // redraw, no relayout
}
async function fetchShares() {
  // shares are minted per daemon — collect active ones from every live wire so
  // the outbound halo shows no matter which machine the shared agent runs on
  const results = await Promise.allSettled(
    [...wires.values()].filter(wireReady).map((w) => apiJSON<{ agentId: string }[]>("/api/shares", w.id)),
  );
  const ids = results.flatMap((p) => (p.status === "fulfilled" ? p.value.map((x) => x.agentId) : []));
  if (ids.length || sharedIds.size) {
    sharedIds = new Set(ids);
    markShared();
  }
}
ctxShareBtn.addEventListener("click", async () => {
  if (!ctxSharePid) return;
  ctxShareBtn.disabled = true;
  ctxShareBtn.textContent = "sharing…";
  const r = await apiPost(
    "/api/share",
    {
      agent: pidOf(ctxSharePid),
      perm: ctxSharePerm.checked ? "rw" : "r",
    },
    srcOf(ctxSharePid), // local-only per openBatchMenu's gate
  );
  ctxShareBtn.disabled = false;
  ctxShareBtn.textContent = "share this node";
  ctxShareOut.hidden = false;
  if (!r.ok) {
    ctxShareLink.textContent = `✗ ${r.text}`;
    return;
  }
  const share = JSON.parse(r.text) as { link: string; agentId: string };
  // present the /r (viewer) form of the capability link — same room+secret,
  // this surface; the holder can flip /r/# to /w/# for the full console
  const link = share.link.replace("/w/#", "/r/#");
  ctxShareLink.textContent = link;
  sharedIds.add(share.agentId);
  markShared();
  try {
    await navigator.clipboard.writeText(link);
  } catch {
    /* clipboard blocked — the link is still selectable */
  }
});
document.getElementById("ctx-share-copy")!.addEventListener("click", async () => {
  const t = ctxShareLink.textContent ?? "";
  if (t && !t.startsWith("✗")) await navigator.clipboard.writeText(t).catch(() => {});
});

// ── chrome controls ──────────────────────────────────────────────────────────
document.getElementById("fit")!.addEventListener("click", () => fitReadable(80));
const wiresBtn = document.getElementById("wires")!;
function syncWiresBtn() {
  wiresBtn.style.color = showWires ? "var(--accent)" : "";
  wiresBtn.style.borderColor = showWires ? "var(--accent)" : "";
}
syncWiresBtn();
wiresBtn.addEventListener("click", () => {
  showWires = !showWires;
  syncWiresBtn();
  applyEdges();
});
document.getElementById("theme")!.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("rgui-theme", next);
  viewer.setTheme(next);
  for (const e of terms.values()) e.term.options.theme = termTheme();
});
// View switcher: same fleet, terminal-console rendering. The bare #<room> is
// enough — the console reconnects from the shared ay.rooms cache (no token in
// the URL). Path-gated to the hosted origin: the local dev:rgui server has no
// /w/ route, so the button would 404 there — hide it.
{
  const consoleBtn = document.getElementById("console") as HTMLButtonElement;
  if (/^\/(r|rgui)(\/|$)/.test(location.pathname)) {
    consoleBtn.addEventListener("click", () => {
      // carry the selected agent as the console's own #<room>:<pid> deep link;
      // ay.sel (written on every selection) covers the same-origin bare cases
      const key = viewer.selection.find((id: string) => recordsByKey.has(id));
      const r = key ? recordsByKey.get(key) : null;
      const frag =
        r && r._src !== LOCAL
          ? "#" + encodeURIComponent(r._src) + ":" + r.pid
          : roomInfo
            ? "#" + encodeURIComponent(roomInfo.room)
            : "";
      location.href = "/w/" + frag;
    });
  } else {
    consoleBtn.hidden = true;
  }
}
