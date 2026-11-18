import { readFile } from "node:fs/promises";
import { chromium, type WebSocketRoute } from "playwright";
import { expect, it } from "vitest";

it("exchanges snapshots directly and reads them offline without re-pairing", async () => {
  const browser = await chromium.launch({
    args: ["--allow-loopback-in-peer-connection", "--disable-features=WebRtcHideLocalIpsWithMdns"],
  });
  const sockets: WebSocketRoute[] = [];
  const signals: string[] = [];
  try {
    const pages = await Promise.all(
      ["alpha", "beta"].map(async (name) => {
        const context = await browser.newContext();
        // Keep CI independent of external STUN and multicast DNS. Chromium
        // still negotiates a real encrypted peer connection and data channel.
        await context.addInitScript(() => {
          window.RTCPeerConnection = class extends RTCPeerConnection {
            constructor(options?: RTCConfiguration) {
              super({ ...options, iceServers: [] });
            }
          };
        });
        await context.route("https://example.test/**", async (route) => {
          const path = new URL(route.request().url()).pathname;
          if (path.endsWith(".js")) {
            const file = path.slice(1);
            if (!["device-sync.js", "device-transfer.js"].includes(file)) return route.abort();
            return route.fulfill({
              contentType: "application/javascript",
              body: await readFile("lab/ui/" + file),
            });
          }
          if (path === "/api/auth/get-session")
            return route.fulfill({ json: { user: { id: "example" } } });
          return route.fulfill({
            contentType: "text/html",
            body:
              '<button id="open">Open</button><dialog><button class="pair">Sync</button><button class="forget">Forget</button><button class="close">Close</button><div role="status"></div><div class="copies"></div></dialog><script type="module">import {mountDeviceSync} from "/device-sync.js"; document.querySelector("#open").onclick=mountDeviceSync({dialog:document.querySelector("dialog"), getLocal:async()=>({rooms:[{name:"room-' +
              name +
              '",token:"synthetic-private",host:"s.example.test",ts:Date.now()}],agents:[{pid:1111,room:"room",status:"idle"}],schedules:[{name:"daily",host:"host",cron:"0 10 * * *",tz:"UTC"}],unavailable:[]}),connect:async()=>true});</script>',
          });
        });
        await context.routeWebSocket("**/api/device-pair", (ws) => {
          sockets.push(ws);
          ws.onMessage((raw) => {
            const msg = String(raw);
            signals.push(msg);
            sockets.find((s) => s !== ws)?.send(msg);
          });
          if (sockets.length === 2) sockets[0].send('{"type":"start"}');
        });
        const page = await context.newPage();
        await page.goto("https://example.test/");
        await page.click("#open");
        return page;
      }),
    );
    expect(sockets.length).toBe(0);
    await Promise.all(pages.map((p) => p.click(".pair")));
    for (const [i, p] of pages.entries()) {
      await expect
        .poll(() => p.locator(".copies").innerText(), { timeout: 25000 })
        .toContain("Connect to room-" + (i ? "alpha" : "beta"));
      expect(await p.locator(".copies").innerText()).toContain("0 10 * * *");
      await expect
        .poll(() => p.locator("[role=status]").innerText())
        .toBe("Both devices saved their copies.");
      await p.click(".close");
      await p.context().route("**/api/auth/get-session", (r) => r.abort());
      await p.click("#open");
      await expect.poll(() => p.locator(".copies").innerText()).toContain("PID 1111");
      await p.click(".forget");
      expect(await p.locator(".copies").innerText()).toBe("");
    }
    expect(signals.map((m) => JSON.parse(m).type).sort()).toEqual(["answer", "offer"]);
    expect(signals.join("")).not.toContain("synthetic-private");
  } finally {
    await browser.close();
  }
});
