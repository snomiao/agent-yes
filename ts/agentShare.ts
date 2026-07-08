// Single-agent, view-only shares (Option X from docs/agent-sharing.md).
//
// A scoped share stands up its OWN e2ee WebRTC room (via startShare, minted
// fresh — never the persisted master fleet room) that exposes exactly ONE agent,
// read-only. The room's host bridge wraps the full `ay serve` API handler in a
// `scopedFetch` that DEFAULT-DENIES and permits only read paths, each verified to
// resolve to the shared `agent_id` (the stable per-process id, not the reusable
// pid). Read-only is enforced here on the host — the browser hiding controls is
// only UX (design principle #1: host-enforced capability, not client-side hiding).
//
// Link format: agent-yes.com/w/#room:grantSecret — the pid is NOT in the URL; the
// scope lives in this host-side share record. Shares are ephemeral (no disk
// persistence): a daemon restart drops them, and a restarted agent mints a fresh
// agent_id, so the holder re-shares (a deliberate NON-GOAL per the design).
import { listRecords, resolveOne, type CommonOpts } from "./subcommands.ts";
import { startShare } from "./share.ts";

export type SharePerm = "r";

export interface ScopedShare {
  shareId: string;
  agentId: string;
  perm: SharePerm;
  room: string;
  link: string;
  label: string; // human hint: cli · cwd basename
  createdAt: number;
  expiresAt: number;
  close: () => void;
}

// Bound concurrent shares: each is its own signaling WS + WebRTC host peer with a
// process.exit self-heal on repeated native peer-setup failure (see ts/share.ts),
// so a fleet of rooms multiplies that risk and the signaling-DO cost. A handful is
// plenty for the intended "show someone this one agent" use.
export const MAX_SHARES = 8;
export const DEFAULT_SHARE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — design "short expiration"

const shares = new Map<string, ScopedShare>();

function lsOpts(all = false): CommonOpts {
  return { all, active: false, json: true, latest: true, cwdScope: null };
}

export function listShares(): Omit<ScopedShare, "close">[] {
  return [...shares.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(({ close: _close, ...s }) => s);
}

export function revokeShare(shareId: string): boolean {
  const s = shares.get(shareId);
  if (!s) return false;
  try {
    s.close();
  } catch {
    /* already closed */
  }
  shares.delete(shareId);
  return true;
}

export function revokeAllShares(): void {
  for (const id of [...shares.keys()]) revokeShare(id);
}

/** Resolve a keyword to a live agent and mint a fresh view-only share room for it. */
export async function createScopedShare(opts: {
  agent: string; // any keyword: pid, agent_id, cwd/cli/prompt substring
  perm?: SharePerm;
  localFetch: (req: Request) => Promise<Response>;
  apiToken: string;
  sighost?: string;
  ttlMs?: number;
}): Promise<Omit<ScopedShare, "close">> {
  if (shares.size >= MAX_SHARES) {
    throw new Error(`too many active shares (max ${MAX_SHARES}) — revoke one first`);
  }
  const record = await resolveOne(opts.agent, lsOpts(true)); // throws if none match
  const agentId = record.agent_id;
  if (!agentId) {
    // Only agents registered with a stable id can be scoped safely; pid alone is
    // reused and unsafe as the security key.
    throw new Error(`agent ${record.pid} has no stable agent_id — cannot share (restart it)`);
  }
  const label = `${record.cli}${record.cwd ? " · " + record.cwd.split("/").filter(Boolean).pop() : ""}`;

  const scoped = scopedFetch(agentId, opts.localFetch, opts.perm ?? "r");
  const { room, link, close } = await startShare({
    localFetch: scoped,
    apiToken: opts.apiToken,
    sighost: opts.sighost,
    // no `url` → startShare mints a fresh, unpersisted room (never the master room)
  });

  const shareId = "s" + Math.abs(hashStr(room + agentId + link)).toString(36);
  const createdAt = Date.now();
  const ttl = opts.ttlMs ?? DEFAULT_SHARE_TTL_MS;
  const expiresAt = createdAt + ttl;

  const stop = () => close();
  const expiryTimer = setTimeout(() => revokeShare(shareId), ttl);
  expiryTimer.unref?.();

  const share: ScopedShare = {
    shareId,
    agentId,
    perm: opts.perm ?? "r",
    room,
    link,
    label,
    createdAt,
    expiresAt,
    close: () => {
      clearTimeout(expiryTimer);
      stop();
    },
  };
  shares.set(shareId, share);
  const { close: _c, ...pub } = share;
  return pub;
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

function forbidden(msg = "read-only share"): Response {
  return new Response(msg, { status: 403 });
}

// Wrap the master API handler so a scoped viewer can ONLY read, and only THIS
// agent. Default-deny: an endpoint not explicitly allowed below is 403.
export function scopedFetch(
  agentId: string,
  inner: (req: Request) => Promise<Response>,
  perm: SharePerm = "r",
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const p = url.pathname;
    const method = req.method;

    // Static host metadata, no agent data.
    if (method === "GET" && p === "/api/version") return inner(req);
    if (method === "GET" && p === "/api/whoami")
      return withShareFlag(await inner(req), agentId, perm);

    // Agent list: force keyword=agentId (cheap server-side narrowing) then
    // post-filter by EXACT agent_id — matchKeyword can fuzzy-match a sibling whose
    // cwd/prompt contains the hex, so the keyword hint is not a boundary on its own.
    if (method === "GET" && (p === "/api/ls" || p === "/api/ls/subscribe")) {
      const scopedUrl = new URL(url);
      scopedUrl.searchParams.set("keyword", agentId);
      scopedUrl.searchParams.delete("all"); // never widen to other/exited agents
      const scopedReq = new Request(scopedUrl.toString(), req);
      const res = await inner(scopedReq);
      return p === "/api/ls" ? filterLsJson(res, agentId) : filterLsSse(res, agentId);
    }

    // Per-agent reads — verify the target resolves to OUR agent_id (403 otherwise).
    const m =
      /^\/api\/(read|tail|status|size)\/(.+)$/.exec(p) && method === "GET"
        ? /^\/api\/(read|tail|status|size)\/(.+)$/.exec(p)
        : null;
    if (m) {
      const kw = decodeURIComponent(m[2]!);
      if (!(await targetIsAgent(kw, agentId))) return forbidden("agent not shared");
      return inner(req);
    }

    // Everything else (send, resize, kill, restart, spawn, presence, notes,
    // spawn-config, share*, …) is a write or a fleet-wide read → denied.
    return forbidden();
  };
}

async function targetIsAgent(keyword: string, agentId: string): Promise<boolean> {
  try {
    const rec = await resolveOne(keyword, lsOpts(true));
    return rec.agent_id === agentId;
  } catch {
    return false;
  }
}

// Add a self-describing read-only capability to /api/whoami so the viewer console
// can enter read-only UI. The host stays the real boundary (writes are 403'd
// regardless); this is a UX hint the browser can trust because it comes from the
// host over the same e2ee channel.
async function withShareFlag(res: Response, agentId: string, perm: SharePerm): Promise<Response> {
  if (!res.ok) return res;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return res;
  }
  const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return Response.json({ ...obj, share: { perm, agent_id: agentId, readonly: perm === "r" } });
}

async function filterLsJson(res: Response, agentId: string): Promise<Response> {
  if (!res.ok) return res;
  let arr: unknown;
  try {
    arr = await res.json();
  } catch {
    return res;
  }
  const kept = Array.isArray(arr)
    ? arr.filter(
        (r) => r && typeof r === "object" && (r as { agent_id?: string }).agent_id === agentId,
      )
    : [];
  return Response.json(kept, { status: res.status });
}

// Filter the /api/ls/subscribe SSE so only the shared agent's deltas cross the
// channel. Each event is `{full?, upsert:[records], remove:[pids]}`; keep only
// upserts whose agent_id matches, and only removes for pids we actually forwarded.
function filterLsSse(res: Response, agentId: string): Response {
  if (!res.ok || !res.body) return res;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const forwarded = new Set<number>();
  let buf = "";

  const stream = new ReadableStream({
    async pull(ctrl) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          ctrl.close();
          return;
        }
        buf += dec.decode(value, { stream: true });
        // Emit each complete SSE event (blank-line separated).
        let sep: number;
        let emittedSomething = false;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const rawEvent = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const out = transformEvent(rawEvent, agentId, forwarded);
          if (out !== null) {
            ctrl.enqueue(enc.encode(out + "\n\n"));
            emittedSomething = true;
          }
        }
        if (emittedSomething) return; // yield to the consumer; resume on next pull
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
  return new Response(stream, {
    status: res.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// Returns the rewritten SSE event text, or null to drop it entirely. Passes
// through comment lines (": ping" heartbeats) and non-data frames unchanged.
function transformEvent(rawEvent: string, agentId: string, forwarded: Set<number>): string | null {
  const trimmed = rawEvent.replace(/\r/g, "");
  if (!trimmed.trim()) return null;
  if (!/^data:/m.test(trimmed)) return trimmed; // comments/heartbeats pass through
  // Reassemble the `data:` payload (SSE allows multiple data: lines per event).
  const dataLines = trimmed
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""));
  const payload = dataLines.join("\n");
  let obj: {
    full?: boolean;
    upsert?: { pid: number; agent_id?: string }[];
    remove?: number[];
  };
  try {
    obj = JSON.parse(payload);
  } catch {
    return null; // malformed — drop rather than leak
  }
  const upsert = (obj.upsert ?? []).filter((r) => r && r.agent_id === agentId);
  for (const r of upsert) forwarded.add(r.pid);
  const remove = (obj.remove ?? []).filter((pid) => forwarded.has(pid));
  for (const pid of remove) forwarded.delete(pid);
  // On the first snapshot always emit (even if empty) so the viewer knows it's
  // connected; later ticks only when something relevant changed.
  if (!obj.full && upsert.length === 0 && remove.length === 0) return null;
  const next = obj.full ? { full: true, upsert, remove } : { upsert, remove };
  return "data: " + JSON.stringify(next);
}
