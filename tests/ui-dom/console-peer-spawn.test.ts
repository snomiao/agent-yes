/**
 * Deterministic DOM test of multi-machine (codehost) rooms in the REAL console
 * (lab/ui/index.html), driven against a stubbed codehost room that holds TWO
 * machines.
 *
 * It pins the two properties that a single-machine room can never exercise:
 *   1. identity — the machines run agents with the SAME pid, and both must show
 *      up as distinct rows. (v1 keyed agents by room+pid, so one silently won.)
 *   2. routing — `+ New agent` spawns on the machine the user picked, not on
 *      whichever peer the room happened to list first.
 *
 * The codehost transport module is replaced wholesale (window.__codehost comes
 * from `import * as codehost from "./room-client.js"`), so no WebRTC, no
 * signaling, no network. Every call the console makes through the room is
 * recorded on window.__chCalls with the peer it was addressed to.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { startServer } from "./server.ts";

const TERMINAL_STUB =
  "window.Terminal=class{constructor(){this.cols=80;this.rows=24;this.element=null;}" +
  "loadAddon(){}open(el){this.element=el;}focus(){}onTitleChange(){}onResize(){}onScroll(){}" +
  "onData(f){window.__onData=f;}onBinary(){}write(){}resize(c,r){this.cols=c;this.rows=r;}" +
  "hasSelection(){return false;}getSelection(){return '';}getSelectionPosition(){return null;}" +
  "clearSelection(){}dispose(){}};";
const FITADDON_STUB = "window.FitAddon={FitAddon:class{activate(){}dispose(){}fit(){}}};";

const ROOM = "ch-test";
const PEER_A = "peer-a";
const PEER_B = "peer-b";
// Both machines run pid 4242 — the collision the per-machine key has to survive.
const DUP_PID = 4242;

// A fake codehost room with two server peers. Mirrors the shape the console uses:
// joinRoom({token,onStatus,onPeers}) -> { peers, rtcs, close, fetch(peerId,…) }.
const ROOM_CLIENT_STUB = `
const T0 = 1700000000000;
const agents = {
  "${PEER_A}": [{ pid: ${DUP_PID}, cli: "claude", cwd: "/srv/alice/tree/main", title: "alice agent", prompt: "", status: "active", started_at: T0 }],
  "${PEER_B}": [{ pid: ${DUP_PID}, cli: "claude", cwd: "/srv/bob/tree/main", title: "bob agent", prompt: "", status: "active", started_at: T0 }],
};
window.__chCalls = [];
let nextPid = 9000;
const resp = (status, payload) => {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return { status, ok: status >= 200 && status < 300, body: null, json: async () => JSON.parse(text), text: async () => text };
};
export function joinRoom({ onStatus, onPeers }) {
  const peers = [
    { peerId: "${PEER_A}", role: "server", meta: { host: "alice@boxA", kind: "root", agents: [] } },
    { peerId: "${PEER_B}", role: "server", meta: { host: "bob@boxB", kind: "root", agents: [] } },
  ];
  const room = {
    peers,
    rtcs: new Map(),
    close() {},
    async fetch(peerId, method, url, init) {
      const path = url.replace("/__codehost/agent-yes", "");
      window.__chCalls.push({ peerId, method, path, body: init && init.body });
      if (method === "GET" && path.startsWith("/api/ls/subscribe")) return resp(404, "no stream");
      if (method === "GET" && path.startsWith("/api/ls")) return resp(200, agents[peerId]);
      if (method === "GET" && path.startsWith("/api/spawn-config")) return resp(200, { hasSpawnHook: false });
      if (method === "GET" && path.startsWith("/api/size")) return resp(200, { cols: 80, rows: 24 });
      if (method === "GET" && path.startsWith("/api/tail")) return resp(404, "no stream");
      if (method === "POST" && path === "/api/spawn") {
        agents[peerId].push({ pid: ++nextPid, cli: "claude", cwd: "/srv/new", title: "spawned", prompt: "", status: "active", started_at: T0 + 1000 });
        return resp(200, "ok");
      }
      return resp(200, {});
    },
  };
  setTimeout(() => {
    onStatus && onStatus(true);
    onPeers && onPeers(peers);
  }, 0);
  return room;
}
export const DEFAULT_SIGNAL_URL = "wss://signal.codehost.dev";
`;

async function openConsole(
  browser: Browser,
  url: string,
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.route(/cdn\.jsdelivr\.net/, (route) => {
    const body = route.request().url().includes("addon-fit") ? FITADDON_STUB : TERMINAL_STUB;
    route.fulfill({ status: 200, contentType: "application/javascript", body });
  });
  await ctx.route(/room-client\.js$/, (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: ROOM_CLIENT_STUB }),
  );
  const page = await ctx.newPage();
  await page.addInitScript(
    ({ room }) => {
      Object.defineProperty(navigator, "platform", { get: () => "Linux x86_64" });
      // A saved codehost room, so connectAllRooms() joins it on boot.
      localStorage.setItem(
        "ay.rooms",
        JSON.stringify({ [room]: { token: "tok", host: "codehost", ts: Date.now() } }),
      );
    },
    { room: ROOM },
  );
  page.on("dialog", (d) => d.accept()); // the "already an agent in this cwd" confirm
  await page.goto(url);
  // 3 local fixture agents + 1 per machine.
  await page.waitForFunction(() => document.querySelectorAll(".list .row").length >= 5, undefined, {
    timeout: 15_000,
  });
  return { ctx, page };
}

const spawnCalls = (page: Page) =>
  page.evaluate(() =>
    (
      (window as never as { __chCalls: { peerId: string; method: string; path: string }[] })
        .__chCalls || []
    ).filter((c) => c.method === "POST" && c.path === "/api/spawn"),
  );

describe("codehost room with two machines", () => {
  let browser: Browser;
  let url: string;
  let close: () => void;

  beforeAll(async () => {
    ({ url, close } = await startServer());
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    close?.();
  });

  it("keeps agents with the same pid on different machines apart", async () => {
    const { ctx, page } = await openConsole(browser, url);
    try {
      // Both survive: the row key is per-machine, not per-room.
      expect(await page.locator(`.row[data-key="${ROOM}/${PEER_A}#${DUP_PID}"]`).count()).toBe(1);
      expect(await page.locator(`.row[data-key="${ROOM}/${PEER_B}#${DUP_PID}"]`).count()).toBe(1);
      const list = await page.locator("#list").innerText();
      expect(list).toContain("alice@boxA");
      expect(list).toContain("bob@boxB");
      // Each machine is polled for its OWN list — not one host answering for both.
      const lsPeers = await page.evaluate(() =>
        [
          ...new Set(
            ((window as never as { __chCalls: { peerId: string; path: string }[] }).__chCalls || [])
              .filter(
                (c) => c.path.startsWith("/api/ls") && !c.path.startsWith("/api/ls/subscribe"),
              )
              .map((c) => c.peerId),
          ),
        ].sort(),
      );
      expect(lsPeers).toEqual([PEER_A, PEER_B]);
    } finally {
      await ctx.close();
    }
  });

  it("spawns on the selected agent's machine by default", async () => {
    const { ctx, page } = await openConsole(browser, url);
    try {
      await page.click(`.row[data-key="${ROOM}/${PEER_B}#${DUP_PID}"]`);
      await page.click("#newbtn");
      await page.waitForSelector("#nf-host");
      // Host picker offers every machine in the fleet: local + boxA + boxB.
      expect(await page.locator("#nf-host option").count()).toBe(3);
      expect(await page.locator("#nf-host").inputValue()).toBe(`${ROOM}/${PEER_B}`);

      await page.click("#nf-go");
      await page.waitForFunction(
        () =>
          (
            (window as never as { __chCalls: { method: string; path: string }[] }).__chCalls || []
          ).some((c) => c.method === "POST" && c.path === "/api/spawn"),
        undefined,
        { timeout: 15_000 },
      );
      const spawns = await spawnCalls(page);
      expect(spawns).toHaveLength(1);
      expect(spawns[0].peerId).toBe(PEER_B); // NOT peer-a, the room's first peer
    } finally {
      await ctx.close();
    }
  });

  it("spawns on the machine chosen in the Host picker", async () => {
    const { ctx, page } = await openConsole(browser, url);
    try {
      // Start from boxB selected, then deliberately retarget to boxA.
      await page.click(`.row[data-key="${ROOM}/${PEER_B}#${DUP_PID}"]`);
      await page.click("#newbtn");
      await page.waitForSelector("#nf-host");
      await page.selectOption("#nf-host", `${ROOM}/${PEER_A}`);
      await page.click("#nf-go");
      await page.waitForFunction(
        () =>
          (
            (window as never as { __chCalls: { method: string; path: string }[] }).__chCalls || []
          ).some((c) => c.method === "POST" && c.path === "/api/spawn"),
        undefined,
        { timeout: 15_000 },
      );
      const spawns = await spawnCalls(page);
      expect(spawns).toHaveLength(1);
      expect(spawns[0].peerId).toBe(PEER_A);
    } finally {
      await ctx.close();
    }
  });
});
