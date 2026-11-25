import { describe, it, expect } from "vitest";
import { scopedFetch } from "./agentShare.ts";

// The security core of single-agent view-only sharing: scopedFetch wraps the full
// `ay serve` API and must DEFAULT-DENY, exposing only reads scoped to ONE agent_id.
// These drive the real filter with a mock inner handler (no WebRTC / no registry).

const SHARED = "aaaaaaaaaaaa"; // the shared agent's stable id
const OTHER = "bbbbbbbbbbbb"; // a sibling on the same host — must never leak

function rec(pid: number, agent_id: string) {
  return { pid, agent_id, cli: "claude", cwd: "/x", status: "running", title: "t" };
}

// A stand-in for the master apiFetch. Records what it was asked and answers a few
// endpoints; the scoped wrapper is what we're testing.
function makeInner(seen: { url?: string }) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    seen.url = req.method + " " + url.pathname + url.search;
    const p = url.pathname;
    if (p === "/api/ls") {
      // The real handler honours ?keyword=; emulate that so we can assert the
      // wrapper both narrows via keyword AND post-filters by exact agent_id.
      const kw = url.searchParams.get("keyword");
      const all = [rec(1, SHARED), rec(2, OTHER)];
      const out = kw ? all.filter((r) => r.agent_id === kw || r.cwd.includes(kw)) : all;
      return Response.json(out);
    }
    if (p === "/api/whoami") return Response.json({ host: "me@box" });
    if (p === "/api/version") return new Response("1.2.3");
    if (p === "/api/ls/subscribe") {
      const enc = new TextEncoder();
      const body = new ReadableStream({
        start(ctrl) {
          // Initial full snapshot with BOTH agents, then a delta touching each.
          ctrl.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ full: true, upsert: [rec(1, SHARED), rec(2, OTHER)], remove: [] })}\n\n`,
            ),
          );
          ctrl.enqueue(enc.encode(`: ping\n\n`));
          ctrl.enqueue(
            enc.encode(`data: ${JSON.stringify({ upsert: [rec(2, OTHER)], remove: [] })}\n\n`),
          );
          ctrl.enqueue(
            enc.encode(`data: ${JSON.stringify({ upsert: [rec(1, SHARED)], remove: [] })}\n\n`),
          );
          ctrl.close();
        },
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    }
    // read/tail/status/size land here only if the wrapper allowed them through.
    return new Response("inner-ok");
  };
}

const mk = (seen: { url?: string } = {}) => scopedFetch(SHARED, makeInner(seen), "r");

async function sse(res: Response): Promise<string> {
  return await res.text();
}

describe("scopedFetch — default-deny writes", () => {
  for (const [method, path] of [
    ["POST", "/api/send"],
    ["POST", "/api/resize/1"],
    ["POST", "/api/kill"],
    ["POST", "/api/restart"],
    ["POST", "/api/spawn"],
    ["POST", "/api/presence"],
    ["GET", "/api/presence"],
    ["POST", "/api/share"],
    ["GET", "/api/notes"],
    ["GET", "/api/spawn-config"],
  ] as const) {
    it(`403s ${method} ${path}`, async () => {
      const res = await mk()(new Request("http://ay.local" + path, { method }));
      expect(res.status).toBe(403);
    });
  }
});

describe("scopedFetch — /api/ls is narrowed and post-filtered", () => {
  it("injects keyword=agentId and returns ONLY the shared agent", async () => {
    const seen: { url?: string } = {};
    const res = await mk(seen)(new Request("http://ay.local/api/ls"));
    expect(seen.url).toContain("keyword=" + SHARED); // narrowed server-side
    const out = (await res.json()) as { agent_id: string }[];
    expect(out).toHaveLength(1);
    expect(out[0]!.agent_id).toBe(SHARED);
  });

  it("post-filters even if the inner handler over-matches (fuzzy keyword)", async () => {
    // Inner that ignores keyword and returns everyone — the wrapper must still cut
    // it down to the shared agent by EXACT agent_id.
    const leaky = scopedFetch(
      SHARED,
      async () => Response.json([rec(1, SHARED), rec(2, OTHER)]),
      "r",
    );
    const out = (await (await leaky(new Request("http://ay.local/api/ls"))).json()) as {
      agent_id: string;
    }[];
    expect(out.map((r) => r.agent_id)).toEqual([SHARED]);
  });
});

describe("scopedFetch — /api/ls/subscribe SSE is filtered", () => {
  it("keeps only the shared agent across snapshot + deltas", async () => {
    const res = await mk()(new Request("http://ay.local/api/ls/subscribe"));
    const text = await sse(res);
    expect(text).toContain('"full":true');
    expect(text).toContain(SHARED);
    expect(text).not.toContain(OTHER); // sibling never crosses the channel
    expect(text).toContain(": ping"); // heartbeat passes through
    // The delta that touched only OTHER must be dropped entirely.
    const dataEvents = text.split("\n\n").filter((e) => e.startsWith("data:"));
    // full snapshot (shared only) + the shared-agent delta = 2 data events.
    expect(dataEvents).toHaveLength(2);
  });
});

describe("scopedFetch — /api/ls/subscribe remove + teardown", () => {
  // Inner whose stream announces both agents, then removes them: only the removal
  // of a pid we actually FORWARDED may cross; a never-forwarded sibling pid is
  // information (its existence) and must be dropped.
  function removalInner(): (req: Request) => Promise<Response> {
    const enc = new TextEncoder();
    return async () =>
      new Response(
        new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(
              enc.encode(
                `data: ${JSON.stringify({ full: true, upsert: [rec(1, SHARED), rec(2, OTHER)], remove: [] })}\n\n`,
              ),
            );
            ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ upsert: [], remove: [2] })}\n\n`));
            ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ upsert: [], remove: [1] })}\n\n`));
            ctrl.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
  }

  it("forwards removes only for pids it forwarded (sibling removals stay hidden)", async () => {
    const res = await scopedFetch(
      SHARED,
      removalInner(),
      "r",
    )(new Request("http://ay.local/api/ls/subscribe"));
    const events = (await sse(res))
      .split("\n\n")
      .filter((e) => e.startsWith("data:"))
      .map((e) => JSON.parse(e.slice(5)) as { upsert: unknown[]; remove: number[] });
    // Snapshot (shared only) + the remove of OUR pid; OTHER's removal is dropped.
    expect(events).toHaveLength(2);
    expect(events[0]!.upsert).toHaveLength(1);
    expect(events[1]!.remove).toEqual([1]);
  });

  it("cancelling the filtered stream tears down the upstream reader", async () => {
    const res = await mk()(new Request("http://ay.local/api/ls/subscribe"));
    await res.body!.cancel(); // viewer went away — must not leak the inner stream
    expect(res.status).toBe(200);
  });
});

describe("scopedFetch — read metadata", () => {
  it("passes /api/version through untouched", async () => {
    const res = await mk()(new Request("http://ay.local/api/version"));
    expect(await res.text()).toBe("1.2.3");
  });

  it("advertises read-only capability on /api/whoami", async () => {
    const res = await mk()(new Request("http://ay.local/api/whoami"));
    const who = (await res.json()) as {
      host: string;
      share: { readonly: boolean; agent_id: string; perm: string };
    };
    expect(who.host).toBe("me@box");
    expect(who.share.readonly).toBe(true);
    expect(who.share.agent_id).toBe(SHARED);
    expect(who.share.perm).toBe("r");
  });

  it("403s a read of an agent that is not the shared one (unknown keyword)", async () => {
    // resolveOne throws for an unknown keyword → targetIsAgent false → 403. Uses a
    // keyword that cannot resolve on this machine, so it never leaks a real agent.
    const res = await mk()(new Request("http://ay.local/api/read/zzzzzzzzzzzz-nope"));
    expect(res.status).toBe(403);
  });
});

describe("scopedFetch — read-write (rw / steer) share", () => {
  const mkRw = () => scopedFetch(SHARED, makeInner({}), "rw");

  it("advertises perm=rw and readonly=false on /api/whoami", async () => {
    const res = await mkRw()(new Request("http://ay.local/api/whoami"));
    const who = (await res.json()) as { share: { readonly: boolean; perm: string } };
    expect(who.share.perm).toBe("rw");
    expect(who.share.readonly).toBe(false);
  });

  it("still DENIES control (kill / restart / spawn) — rw is steer, not control", async () => {
    for (const path of ["/api/kill", "/api/restart", "/api/spawn"]) {
      const res = await mkRw()(new Request("http://ay.local" + path, { method: "POST" }));
      expect(res.status).toBe(403);
    }
  });

  it("DENIES send/resize aimed at an agent that isn't the shared one", async () => {
    // keyword can't resolve on this machine → targetIsAgent false → 403, so an rw
    // holder can only steer THE shared agent, never a sibling.
    const send = await mkRw()(
      new Request("http://ay.local/api/send", {
        method: "POST",
        body: JSON.stringify({ keyword: "zzzzzzzzzzzz-nope", msg: "x" }),
      }),
    );
    expect(send.status).toBe(403);
    const resize = await mkRw()(
      new Request("http://ay.local/api/resize/zzzzzzzzzzzz-nope", { method: "POST" }),
    );
    expect(resize.status).toBe(403);
  });

  it("still denies send on a VIEW-ONLY (r) share", async () => {
    const res = await mk()(
      new Request("http://ay.local/api/send", {
        method: "POST",
        body: JSON.stringify({ keyword: "1", msg: "x" }),
      }),
    );
    expect(res.status).toBe(403);
  });
});
