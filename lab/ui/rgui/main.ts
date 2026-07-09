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
  nodeHeight,
  type Edge,
  type Graph,
  type GraphNode,
  type Panel,
  type PanelItem,
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
}

// ── data source: room · HTTP · sample ────────────────────────────────────────
// The viewer reads from ONE of three wires, in priority order:
//   1. a WebRTC room — when the URL hash is a share link (#room:token[@host] or
//      webrtc://…): every /api/* call tunnels over the SAME DataChannel the
//      console uses (rtc.js + e2e.js). This makes /r/#room:token@s.agent-yes.com
//      show the host's REAL live agents.
//   2. same-origin HTTP — the localhost `dev:rgui` / `ay serve` path (no room).
//   3. the baked sample forest — when neither is reachable (static preview).
// roomInfo is fixed at load from the hash. When a room IS configured we never
// fall back to HTTP or the sample — you opened a share link, so we show that
// room or its connection state.
const roomInfo = parseRoomHash(location.hash) as
  | { room: string; token: string; host: string }
  | null;
let room: InstanceType<typeof RTCClient> | null = null; // connected client (or null)
let roomConnected = false;
const usingRoom = () => !!roomInfo;
const roomReady = () => !!(room && roomConnected);

// GET a JSON body over the active wire (throws on any failure).
async function apiJSON<T>(path: string): Promise<T> {
  if (usingRoom()) {
    if (!roomReady()) throw new Error("room not connected");
    return JSON.parse((await room!.req("GET", path)).text) as T;
  }
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(String(res.status));
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("json")) throw new Error("not json"); // static host served HTML
  return res.json() as Promise<T>;
}

// POST a JSON body over the active wire (never throws; returns {ok,text}).
async function apiPost(path: string, body: unknown): Promise<{ ok: boolean; text: string }> {
  if (usingRoom()) {
    if (!roomReady()) return { ok: false, text: "room not connected" };
    const r = await room!.req("POST", path, JSON.stringify(body));
    return { ok: r.status >= 200 && r.status < 300, text: r.text };
  }
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, text: await r.text() };
}

// Subscribe to an SSE-style stream over the active wire. onData receives each
// parsed `data:` value (the raw terminal chunk) — identical to what an
// EventSource.onmessage handler gets after JSON.parse(ev.data). Returns a handle
// with .close() (drop-in for the EventSource the terminals used to hold).
interface Sub {
  close(): void;
}
function subscribeRaw(path: string, onData: (v: unknown) => void): Sub {
  if (usingRoom()) {
    if (!roomReady()) return { close() {} };
    // room.subscribe yields raw DataChannel bytes — reassemble the SSE `data:`
    // frames exactly the way the console's rtcTx does.
    let buf = "";
    const unsub = room!.subscribe(path, (raw: string) => {
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
  const ev = new EventSource(path);
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

function nodeOf(r: AgentRecord): GraphNode {
  const branch = r.git?.branch ?? null;
  const prompt = (r.prompt ?? "").replace(/\s+/g, " ").trim();
  const fields: [string, string][] = [
    ["pid", String(r.pid)],
    ["status", r.status],
    ["cwd", shortCwd(r.cwd)],
  ];
  if (branch) fields.push(["branch", (r.git?.dirty ? "±" : "") + branch]);
  if (r.last_active_at) fields.push(["active", ago(r.last_active_at) + " ago"]);
  if (r.question) fields.push(["waiting", r.question.slice(0, 48)]);
  else if (prompt) fields.push(["prompt", prompt.slice(0, 56) + (prompt.length > 56 ? "…" : "")]);
  return {
    id: String(r.pid),
    title: nodeTitle(r),
    category: CATEGORY[r.status] ?? r.status,
    x: 0,
    y: 0,
    w: CARD_W,
    // one in/out port so relationship wires (reads/sends) can anchor to the node
    inputs: [{ id: "i", label: "", kind: "ctl" }],
    outputs: [{ id: "o", label: "", kind: "ctl" }],
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
  const byPid = new Map<number, AgentRecord>();
  for (const r of records) byPid.set(r.pid, r);
  // wrapper_pid → the agent it belongs to, so a child's parent_pid resolves to a
  // node id (the parent agent's own pid).
  const ownerOfWrapper = new Map<number, number>();
  for (const r of records) if (r.wrapper_pid != null) ownerOfWrapper.set(r.wrapper_pid, r.pid);

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
    const id = String(r.pid);
    const parentPid = r.parent_pid != null ? ownerOfWrapper.get(r.parent_pid) : undefined;
    const parentSameCwd =
      parentPid != null &&
      parentPid !== r.pid &&
      nodes.has(String(parentPid)) &&
      byPid.get(parentPid)!.cwd === r.cwd;
    if (parentSameCwd) {
      nodes.get(id)!.parent = String(parentPid);
      children.get(String(parentPid))!.push(id);
    } else {
      cwdRoots.push(id);
    }
  }

  // Snap agents together by cwd, then by repo. Agents in the SAME cwd cluster into
  // a same-cwd container that surfaces their SHARED state (the loudest member —
  // needs_input > stuck > active > idle); same-repo cwds then cluster into the
  // repo container. A cwd/repo with a single member stays loose.
  cwdGroups.clear();
  const byRepo = new Map<string, string[]>();
  for (const id of cwdRoots) {
    const key = repoOf(byPid.get(Number(id))!.cwd).key;
    (byRepo.get(key) ?? byRepo.set(key, []).get(key)!).push(id);
  }
  const topLevel: string[] = [];
  for (const [repoKey, repoIds] of byRepo) {
    // sub-group this repo's agents by EXACT cwd (same worktree)
    const byCwd = new Map<string, string[]>();
    for (const id of repoIds) {
      const cwd = byPid.get(Number(id))!.cwd;
      (byCwd.get(cwd) ?? byCwd.set(cwd, []).get(cwd)!).push(id);
    }
    const repoChildren: string[] = [];
    for (const [cwd, cids] of byCwd) {
      if (cids.length < 2) {
        repoChildren.push(...cids);
        continue;
      }
      const st = aggStateOf(cids);
      const cwdId = `cwd:${cwd}`;
      cwdGroups.set(cwdId, cids);
      nodes.set(cwdId, {
        id: cwdId,
        title: cwd.slice(repoKey.length).replace(/^\/(tree\/)?/, "") || cwd,
        category: `cwd-${st}`, // header colored by the group's shared state
        x: 0,
        y: 0,
        w: CARD_W,
        inputs: [],
        outputs: [],
        fields: [
          ["agents", String(cids.length)],
          ["shared", st],
        ],
      });
      children.set(cwdId, cids);
      for (const id of cids) nodes.get(id)!.parent = cwdId;
      repoChildren.push(cwdId);
    }
    if (repoChildren.length < 2) {
      topLevel.push(...repoChildren);
      continue;
    }
    const repoId = `repo:${repoKey}`;
    nodes.set(repoId, {
      id: repoId,
      title: repoOf(byPid.get(Number(repoIds[0]))!.cwd).label,
      category: "repo",
      x: 0,
      y: 0,
      w: CARD_W,
      inputs: [],
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
  // so a full-forest fit frames both. Its HTML overlay is (re)attached after
  // setGraph by attachInfoOverlay(); here it's just a positioned node with a
  // canvas draw for the zoomed-out LOD.
  nodes.set(INFO_ID, {
    id: INFO_ID,
    title: "agent-yes · console",
    category: "info",
    x: 0,
    y: -(INFO_H + ROW_GAP + 20),
    w: INFO_W,
    h: INFO_H,
    inputs: [],
    outputs: [],
    fields: [],
    draw: drawInfoCard,
  });
  children.set(INFO_ID, []);

  // containers (nodes with children) render as frames around their kids — a
  // terminal "over" them would cover the children, so only LEAF agents get a
  // live terminal overlay.
  isContainer = new Set([...children].filter(([, k]) => k.length > 0).map(([id]) => id));
  // leaf agent nodes render via our LOD draw hook (terminal snapshot / identity),
  // instead of rgui's default field card — see drawNode.
  for (const n of nodes.values()) {
    if (!isContainer.has(n.id) && !n.id.startsWith("repo:") && !n.id.startsWith("info:")) {
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
const recordsByPid = new Map<string, AgentRecord>();

// relationship wires: recent agent→agent read/tail edges (from /api/edges).
interface ReadEdge {
  by: number;
  target: number;
  at: number;
}
let readEdges: ReadEdge[] = [];
let showWires = true;

// same-cwd groups (cwdId → member pids); their container surfaces the group's
// SHARED state (the loudest member), refreshed on every content poll.
const cwdGroups = new Map<string, string[]>();
const STATE_RANK: AgentStatus[] = ["needs_input", "stuck", "active", "idle", "exited"];
function aggStateOf(pids: string[]): AgentStatus {
  const s = new Set(pids.map((p) => recordsByPid.get(p)?.status).filter(Boolean));
  return STATE_RANK.find((x) => s.has(x)) ?? "idle";
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

function makeTerm(pid: string): TermEntry | null {
  const r = recordsByPid.get(pid);
  if (!XTermCtor || !r) return null;
  const el = document.createElement("div");
  el.className = "ay-term";
  el.dataset.rguiInteractive = "1"; // let scroll/select inside the terminal work
  const bar = document.createElement("div");
  bar.className = "ay-term-bar";
  bar.innerHTML =
    `<span class="dot ${r.status}"></span>` +
    `<span class="t"></span><span class="pid">#${pid}</span>`;
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
    : subscribeRaw(`/api/tail/${encodeURIComponent(pid)}?raw=1`, onStream);
  const entry: TermEntry = { el, term, es, miss: 0, buf: "" };
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
  apiJSON<{ cols?: number; rows?: number }>(`/api/size/${encodeURIComponent(pid)}`)
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
  const r = recordsByPid.get(id);
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
    const lines = [`#${id} · ${r.status}`, shortCwd(r.cwd) + (r.git?.branch ? ` ⎇${r.git.branch}` : "")];
    if (r.question) lines.push(`⏳ ${r.question.slice(0, 40)}`);
    lines.forEach((ln, i) => ctx.fillText(ln, 8, bodyY + 8 + i * (fs + 3)));
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

// The copyable HTML mirror, built once and re-anchored over the info node after
// each setGraph. Real selectable text + a copy button per command (canvas can't
// host either). rgui scale:"fit"s it into the node's screen rect.
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
// Register the copyable info overlay ONCE, the first time its node exists. rgui
// remembers imperative overlays by node id and re-binds them onto the new node
// objects every setGraph, so there's no need to re-attach on each rebuild.
let infoOverlayAttached = false;
function attachInfoOverlay() {
  if (infoOverlayAttached) return;
  if (!viewer.graph.nodes.some((n) => n.id === INFO_ID)) return;
  viewer.setNodeOverlay(INFO_ID, {
    el: ensureInfoOverlay(),
    anchor: "over",
    scale: "fit",
    minScale: 0.16, // readable at the default forest fit; hides only far out
    maxScale: 1,
    clip: "node",
    overflow: "hidden",
    interactive: true,
  });
  infoOverlayAttached = true;
}

// Decide which nodes deserve a live terminal this frame (on-screen leaf nodes,
// big enough, capped by area), create/tear down to match.
let lastTermSync = 0;
function syncTerminals(view: { x: number; y: number; k: number }) {
  if (!XTermCtor) return;
  const cw = canvas.clientWidth || innerWidth;
  const ch = canvas.clientHeight || innerHeight;
  const cand: { id: string; area: number }[] = [];
  for (const n of viewer.graph.nodes) {
    if (isContainer.has(n.id) || !recordsByPid.has(n.id)) continue; // skip containers + the info card
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
  const r = id ? recordsByPid.get(id) : undefined;
  if (r) {
    document.title = `${STATUS_GLYPH[r.status] ?? ""} ${nodeTitle(r)} · agent-yes`.trim();
  } else {
    const n = recordsByPid.size;
    document.title = n ? `agent-yes · rgui · ${n} agents` : "agent-yes · rgui — live agent tree";
  }
}

// ── system status palette (screen-fixed rgui Panel) ──────────────────────────
// A viewport-anchored panel — it never zooms or pans with the world, unlike the
// info card. Shows the fleet at a glance: live/total agents (title) + a
// per-status breakdown (items). Drag its header and rgui snaps it to the
// viewport edges / other panels; onPanelMove persists the anchor across reloads.
const SYS_PANEL_KEY = "rgui-syspanel-anchor";
function loadPanelAnchor(): Panel["anchor"] {
  try {
    const raw = localStorage.getItem(SYS_PANEL_KEY);
    if (raw === "left" || raw === "right") return raw;
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p.x === "number" && typeof p.y === "number") return p;
    }
  } catch {
    /* corrupt stored anchor — fall through to the default edge */
  }
  return "right";
}
const sysPanel: Panel = { id: "sys", title: "agents", anchor: loadPanelAnchor(), w: 200, items: [] };
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
  items.push({
    id: "conn",
    label: live ? (usingRoom() ? "live · room" : "live · local") : "demo · no ay serve",
    color: live ? "#3fb950" : "#d29922",
  });
  sysPanel.items = items;
  viewer.setPanels([sysPanel]);
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
  onPanelMove: (_p, anchor) => {
    // persist the dragged/snapped anchor so the palette stays where the user left it
    try {
      localStorage.setItem(SYS_PANEL_KEY, JSON.stringify(anchor));
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
    // container expands to its agent descendants.
    const sel = viewer.selection;
    const base = sel.includes(id) && sel.length > 0 ? [...sel] : [id];
    if (!sel.includes(id)) viewer.setSelection(base);
    const set = new Set<string>();
    for (const t of base) {
      if (recordsByPid.has(t)) set.add(t);
      else for (const d of agentDescendants(t)) set.add(d);
    }
    const targets = [...set];
    if (targets.length) openBatchMenu(screen.x, screen.y, targets);
  },
  onSelectionChange: () => {
    updateNodeDebug();
    updateDocTitle(); // tab title follows the selected agent
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
(window as unknown as { __rgui: unknown }).__rgui = { viewer, get graph() { return viewer.graph; } };

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
    .map((r) => `${r.pid}>${r.parent_pid ?? ""}`)
    .sort()
    .join("|");
}
function contentSig(records: AgentRecord[]): string {
  return records
    .map((r) => `${r.pid}:${r.status}:${r.question ?? ""}:${r.title ?? ""}:${r.git?.branch ?? ""}`)
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
  const byId = new Map(records.map((r) => [String(r.pid), r] as const));
  for (const n of viewer.graph.nodes) {
    const r = byId.get(n.id);
    if (r) {
      const fresh = nodeOf(r);
      n.title = fresh.title;
      n.category = fresh.category;
      n.fields = fresh.fields;
    } else if (cwdGroups.has(n.id)) {
      // same-cwd container: recompute the shared (loudest) state in place
      const st = aggStateOf(cwdGroups.get(n.id)!);
      n.category = `cwd-${st}`;
      n.fields = [["agents", String(cwdGroups.get(n.id)!.length)], ["shared", st]];
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

function apply(records: AgentRecord[], live: boolean) {
  recordsByPid.clear();
  for (const r of records) recordsByPid.set(String(r.pid), r);
  const struct = structureSig(records);
  const content = contentSig(records);
  if (struct !== lastStruct) {
    lastStruct = struct;
    lastContent = content;
    // tear down terminals for agents that are gone (exited/removed)
    for (const id of [...terms.keys()]) if (!recordsByPid.has(id)) dropTerm(id);
    viewer.setGraph(buildGraph(records));
    attachInfoOverlay(); // one-time register; rgui re-binds it across later setGraphs
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
  statusLabel.textContent = live
    ? `live · ${n} agent${n === 1 ? "" : "s"}${usingRoom() ? " (room)" : ""}`
    : "demo · no local ay serve";
  updateSysPanel(records, live); // refresh the screen-fixed status palette
  updateDocTitle(); // keep the tab title's name/status/count fresh
}

// Rebuild the relationship wires (read/tail edges between present agent nodes) on
// the current graph and redraw — cheap, no relayout. Called on structure change,
// the edge poll, and the wire toggle.
function applyEdges() {
  const present = new Set(viewer.graph.nodes.map((n) => n.id));
  const edges: Edge[] = showWires
    ? readEdges
        .filter((e) => e.by !== e.target && present.has(String(e.by)) && present.has(String(e.target)))
        .map((e) => ({
          from: { node: String(e.by), port: "o" },
          to: { node: String(e.target), port: "i" },
          dashed: true,
          style: { color: "#58a6ff", width: 1.5, dash: [6, 4] },
        }))
    : [];
  viewer.graph.edges.length = 0;
  viewer.graph.edges.push(...edges);
  viewer.setView(viewer.view); // schedule a redraw without a relayout
}

async function fetchEdges() {
  try {
    readEdges = (await apiJSON<{ reads?: ReadEdge[] }>("/api/edges")).reads ?? [];
    applyEdges();
  } catch {
    /* no /api/edges (static host / old daemon / room down) — leave wires empty */
  }
}

async function refresh() {
  try {
    const records = await apiJSON<AgentRecord[]>("/api/ls");
    apply(records, true);
    void fetchEdges();
  } catch {
    // No reachable source. With a room configured, keep the room's connection
    // state on screen (never the sample) — the connect loop drives the label.
    // Without one, fall back to the sample forest (only until live appears).
    if (!usingRoom() && !liveKnown) apply(sampleRecords(), false);
  }
}

// ── room connection (only when the hash is a share link) ─────────────────────
// Connect the shared RTCClient and keep it alive with jittered exponential
// backoff — a dropped DataChannel (host restart) otherwise leaves the room dead
// until a manual reload. Mirrors the console's connectRtcSource lifecycle.
if (roomInfo) {
  const RTC_MIN = 1000;
  const RTC_MAX = 30000;
  let delay = RTC_MIN;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const setRoomLabel = (text: string) => {
    statusEl.className = "demo";
    statusLabel.textContent = text;
  };
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
    if (room) {
      room.onstate = () => {};
      try {
        room.close();
      } catch {
        /* */
      }
      room = null;
    }
    roomConnected = false;
    if (!liveKnown) setRoomLabel("connecting room…");
    try {
      const c = new RTCClient(roomInfo!.host, roomInfo!.room, roomInfo!.token);
      c.onstate = (st: string) => {
        // "disconnected" is transient (ICE hiccup) — only a real teardown reconnects.
        if (st === "failed" || st === "closed") {
          roomConnected = false;
          setRoomLabel("room disconnected");
          schedule();
        }
      };
      await c.connect();
      room = c;
      roomConnected = true;
      delay = RTC_MIN; // a healthy connect resets the backoff
      void refresh(); // pull the first snapshot over the room immediately
    } catch {
      setRoomLabel("room disconnected");
      schedule();
    }
  }
  setRoomLabel("connecting room…");
  void connectOnce();
}

refresh();
setInterval(refresh, 3000);

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
  viewer.setView({ k, x: cw / 2 - (n.x + n.w / 2) * k, y: ch / 2 - (n.y + h / 2) * k });
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

// ── ⌘K command palette (go to / focus an agent) ───────────────────────────────
const cmdk = document.getElementById("cmdk")!;
const cmdkInput = document.getElementById("cmdk-input") as HTMLInputElement;
const cmdkList = document.getElementById("cmdk-list")!;
const escHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
let cmdkSel = 0;
let cmdkRows: { id: string; title: string; status: string; sub: string }[] = [];

function cmdkData() {
  const rows = [...recordsByPid.values()].map((r) => ({
    id: String(r.pid),
    title: nodeTitle(r),
    status: r.status,
    sub: shortCwd(r.cwd) + (r.git?.branch ? ` ⎇${r.git.branch}` : ""),
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
    if (!recordsByPid.has(n.id)) continue;
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
function openBatchMenu(sx: number, sy: number, pids: string[]) {
  ctxTargets = pids;
  document.getElementById("ctx-count")!.textContent = String(pids.length);
  document.getElementById("ctx-s")!.textContent = pids.length === 1 ? "" : "s";
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
    pids.map((pid) =>
      apiPost("/api/send", { keyword: pid, msg }).then((r) =>
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
ctxInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void sendBatch();
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeBatchMenu();
  }
  e.stopPropagation();
});
document.getElementById("ctx-send")!.addEventListener("click", () => void sendBatch());
addEventListener("mousedown", (e) => {
  if (!ctxmenu.hidden && !ctxmenu.contains(e.target as Node)) closeBatchMenu();
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
