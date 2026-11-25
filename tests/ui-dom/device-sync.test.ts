import { readFile } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { expect, it } from "vitest";
import { DeviceSignal } from "../../lab/ui/cf/device-signal";

// Run the production room rendezvous with Playwright's in-process WebSocket
// routes. Chromium still negotiates real encrypted peer connections.
it("automatically syncs only checked rooms, handles late peers and clears imported access on sign-out", async () => {
  const browser = await chromium.launch({
    args: ["--allow-loopback-in-peer-connection", "--disable-features=WebRtcHideLocalIpsWithMdns"],
  });
  const server = new DeviceSignal(),
    wire: string[] = [];
  let open = 0;
  async function device(seed = false) {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      const frames: string[] = [];
      Object.assign(window, { syncFrames: frames });
      RTCDataChannel.prototype.send = new Proxy(RTCDataChannel.prototype.send, {
        apply(send, channel, args) {
          if (channel.label === "device-sync") frames.push(String(args[0]));
          return Reflect.apply(send, channel, args);
        },
      });
      window.RTCPeerConnection = class extends RTCPeerConnection {
        constructor(options?: RTCConfiguration) {
          super({ ...options, iceServers: [] });
        }
      };
    });
    await ctx.routeWebSocket("**/api/device-pair", (ws) => {
      open++;
      const socket = Object.assign(new EventTarget(), {
        send(raw: string) {
          wire.push(raw);
          ws.send(raw);
        },
        close() {
          ws.close();
        },
      });
      ws.onClose(() => {
        open--;
        socket.dispatchEvent(new Event("close"));
      });
      ws.onMessage((data) => {
        wire.push(String(data));
        socket.dispatchEvent(new MessageEvent("message", { data }));
      });
      server.attach(socket as unknown as WebSocket);
    });
    let signed = true;
    await ctx.route("https://example.test/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/auth/get-session")
        return route.fulfill({ json: signed ? { user: { id: "example" } } : null });
      if (path === "/api/auth/sign-out") {
        signed = false;
        return route.fulfill({ json: {} });
      }
      if (path.endsWith(".js")) {
        const file = path.replace(/^\/w\//, "/").slice(1);
        return route.fulfill({
          contentType: "application/javascript",
          body: await readFile("lab/ui/" + file),
        });
      }
      return route.fulfill({
        contentType: "text/html",
        body: `<button id="open">Settings</button>
        <dialog><div class="checklist"></div><div class="copies"></div><div role="status"></div><button class="forget"></button><button class="close"></button></dialog>
        <script type="module">
        import {mountDeviceSync} from "./device-sync.js";
        import {signOut} from "/auth/profile.js";
        window.logout=signOut;
        const loadRooms=()=>JSON.parse(localStorage.getItem("ay.rooms")||"{}");
        if (${seed} && !localStorage.getItem("ay.rooms")) {
          const room = token => ({token,host:"signal.example.test",ts:Date.now()});
          localStorage.setItem("ay.rooms",JSON.stringify({shared:room("fixture-checked"),private:room("fixture-unchecked")}));
        }
        const sync=mountDeviceSync({dialog:document.querySelector("dialog"),loadRooms,
          compatible:()=>true, disconnect:()=>{},changed:()=>{},
          collect:async name=>({agents:[{pid:1111,status:"idle"}],schedules:[{host:name,name:"daily",cron:"0 10 * * *",tz:"UTC"}],unavailable:[]}),
          connect:r=>document.body.dataset.connected=r.name
        });
        document.querySelector("#open").onclick=sync.open;
        </script>`,
      });
    });
    const p = await ctx.newPage();
    await p.goto("https://example.test/w/");
    return p;
  }
  const rooms = (p: Page) => p.evaluate(() => JSON.parse(localStorage.getItem("ay.rooms") || "{}"));
  try {
    const a = await device(true),
      b = await device();
    await expect.poll(() => open).toBe(2);
    await a.click("#open");
    const box = a.getByLabel("Sync · shared");
    expect(await box.isChecked()).toBe(false);
    await box.check();
    await expect.poll(async () => (await rooms(b)).shared?.sync, { timeout: 20000 }).toBe(true);
    expect((await rooms(b)).private).toBeUndefined();
    expect(await b.locator("body").getAttribute("data-connected")).toBe("shared");
    // The receiving console was never opened by the user.
    await b.click("#open");
    expect(await b.locator(".copies").innerText()).toContain("0 10 * * *");
    const c = await device();
    await expect
      .poll(async () => (await rooms(c)).shared?.token, { timeout: 20000 })
      .toBe("fixture-checked");
    expect((await rooms(c)).private).toBeUndefined();
    await b.context().setOffline(true);
    await b.evaluate(() => window.dispatchEvent(new Event("offline")));
    expect(await b.locator(".copies").innerText()).toContain("PID 1111");
    await box.uncheck();
    await expect.poll(async () => (await rooms(c)).shared?.sync, { timeout: 20000 }).toBe(false);
    await b.context().setOffline(false);
    await b.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(async () => (await rooms(b)).shared?.sync, { timeout: 20000 }).toBe(false);
    await b.evaluate(() => (window as unknown as { logout: () => Promise<void> }).logout());
    expect(await rooms(b)).toEqual({});
    expect(await b.locator(".copies").innerText()).toBe("");
    expect(await b.evaluate(() => localStorage.getItem("ay.peerOwner"))).toBeNull();
    await expect.poll(() => open).toBe(2);
    const frames = await a.evaluate(() =>
      (window as unknown as { syncFrames: string[] }).syncFrames.join(""),
    );
    expect(frames).toContain("fixture-checked");
    expect(frames).not.toContain("fixture-unchecked");
    expect(frames).not.toContain("private");
    for (const raw of wire) {
      const m = JSON.parse(raw);
      expect(["start", "refresh", "offer", "answer"]).toContain(m.type);
      expect(
        Object.keys(m).every((k) => ["type", "peer", "round", "offer", "sdp"].includes(k)),
      ).toBe(true);
      expect(raw).not.toMatch(
        /fixture-checked|fixture-unchecked|signal\.example\.test|daily|0 10 \*|PID 1111/,
      );
    }
  } finally {
    await browser.close();
  }
});

it("keeps the real console's drawer and Settings checkboxes in step across reloads", async () => {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ serviceWorkers: "block" });
    await ctx.routeWebSocket("**/*", () => {});
    await ctx.route("**/*", async (route) => {
      const { origin, pathname } = new URL(route.request().url());
      if (origin !== "https://example.test") return route.abort();
      if (pathname === "/api/auth/get-session")
        return route.fulfill({ json: { user: { id: "test" }, session: {} } });
      if (!pathname.startsWith("/w/") && !pathname.startsWith("/auth/"))
        return route.fulfill({ status: 404 });
      const file = pathname === "/w/" ? "index.html" : pathname.replace(/^\/(w\/)?/, "");
      const body = await readFile("lab/ui/" + file);
      return route.fulfill({
        body,
        contentType: file.endsWith(".js")
          ? "application/javascript"
          : file.endsWith(".html")
            ? "text/html"
            : "text/plain",
      });
    });
    await ctx.addInitScript(() => {
      if (!localStorage.getItem("ay.rooms"))
        localStorage.setItem(
          "ay.rooms",
          JSON.stringify({
            "sample-room": { token: "fixture", host: "signal.example.test", ts: Date.now() },
          }),
        );
    });
    const p = await ctx.newPage();
    await p.goto("https://example.test/w/");
    await p.click("#conn");
    const drawer = p.locator('#rooms input[data-sync="sample-room"]');
    await drawer.check();
    await p.click("#viewmenubtn");
    await p.click("#device-sync");
    const settings = p.locator("#sync-dialog").getByLabel("Sync · sample-room");
    expect(await settings.isChecked()).toBe(true);
    await settings.uncheck();
    await p.click("#sync-dialog .close");
    expect(await drawer.isChecked()).toBe(false);
    await p.reload();
    await p.click("#conn");
    expect(await drawer.isChecked()).toBe(false);
  } finally {
    await browser.close();
  }
});
