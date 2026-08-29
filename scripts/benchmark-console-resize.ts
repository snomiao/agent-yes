import { chromium } from "playwright";
import { startServer, AGENTS } from "../tests/ui-dom/server.ts";

const counts = [1, 10, 20, 30];
const percentile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const sorted = xs.slice().sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * q)]!;
};

const browser = await chromium.launch({ headless: true });
try {
  for (const count of counts) {
    const agents = Array.from({ length: count }, (_, i) => ({
      ...AGENTS[i % AGENTS.length],
      pid: 10_000 + i,
      title: `resize benchmark ${i + 1}`,
      cwd: `/home/u/ws/bench/repo-${i}/tree/main`,
    }));
    const server = await startServer(agents);
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const metrics = ((window as any).__resizeBench = {
        events: 0,
        fits: [] as number[],
        longTasks: [] as number[],
        frameGaps: [] as number[],
        running: false,
      });
      window.addEventListener("resize", () => metrics.events++);
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) metrics.longTasks.push(entry.duration);
        }).observe({ entryTypes: ["longtask"] });
      } catch {}
      let addon: any;
      Object.defineProperty(window, "FitAddon", {
        configurable: true,
        get: () => addon,
        set(value) {
          const original = value?.FitAddon?.prototype?.fit;
          if (original) {
            value.FitAddon.prototype.fit = function (...args: unknown[]) {
              const start = performance.now();
              try {
                return original.apply(this, args);
              } finally {
                metrics.fits.push(performance.now() - start);
              }
            };
          }
          addon = value;
        },
      });
      let previous = 0;
      const frame = (now: number) => {
        if (metrics.running) {
          if (previous) metrics.frameGaps.push(now - previous);
          previous = now;
          requestAnimationFrame(frame);
        }
      };
      (window as any).__startResizeBench = () => {
        metrics.events = 0;
        metrics.fits = [];
        metrics.longTasks = [];
        metrics.frameGaps = [];
        metrics.running = true;
        previous = 0;
        requestAnimationFrame(frame);
      };
      (window as any).__stopResizeBench = () => (metrics.running = false);
    });
    let resizePosts = 0;
    let presencePosts = 0;
    let inputPosts = 0;
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      const url = request.url();
      if (url.includes("/api/resize/")) resizePosts++;
      else if (url.includes("/api/presence")) presencePosts++;
      else if (url.includes("/api/send")) inputPosts++;
    });
    try {
      await page.goto(server.url);
      await page.waitForSelector(`.list .row[data-key="local#${agents[0]!.pid}"]`);
      await page.click(`.list .row[data-key="local#${agents[0]!.pid}"]`);
      await page.waitForSelector("#log .xterm");
      await page.locator("#log .xterm-helper-textarea").focus();
      await page.waitForTimeout(150);
      resizePosts = presencePosts = inputPosts = 0;
      await page.evaluate(() => (window as any).__startResizeBench());
      const started = performance.now();
      for (let i = 0; i < 60; i++) {
        await page.setViewportSize({ width: 1100 + (i % 2) * 180, height: 720 + (i % 3) * 30 });
        if (i % 10 === 0) await page.keyboard.type("z");
      }
      await page.waitForTimeout(200);
      const elapsed = performance.now() - started;
      const metrics = await page.evaluate(() => {
        (window as any).__stopResizeBench();
        return (window as any).__resizeBench;
      });
      console.log(
        JSON.stringify({
          agents: count,
          elapsedMs: +elapsed.toFixed(1),
          resizeEvents: metrics.events,
          fitCalls: metrics.fits.length,
          fitP50Ms: +percentile(metrics.fits, 0.5).toFixed(2),
          fitP95Ms: +percentile(metrics.fits, 0.95).toFixed(2),
          frameGapP95Ms: +percentile(metrics.frameGaps, 0.95).toFixed(2),
          frameGapMaxMs: +Math.max(0, ...metrics.frameGaps).toFixed(2),
          longTasks: metrics.longTasks.length,
          resizePosts,
          presencePosts,
          inputPosts,
        }),
      );
    } finally {
      await context.close();
      server.close();
    }
  }
} finally {
  await browser.close();
}
