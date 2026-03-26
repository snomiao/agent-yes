/**
 * UI test: renders agent-yes PTY output in xterm.js via Playwright,
 * then uses Gemini Vision to judge whether the terminal looks correct.
 *
 * Run with:
 *   bun tests/ui-test/ui.test.ts
 * or via vitest:
 *   bunx vitest run tests/ui-test/ui.test.ts
 */

import { chromium, type Browser, type Page } from "playwright";
import { GoogleGenerativeAI, type Part } from "@google/generative-ai";
import { startServer } from "./server.ts";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { describe, it, beforeAll, afterAll, expect } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = join(__dirname, "screenshots");
mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// Load GEMINI_API_KEY from .env.local
function loadEnvLocal() {
  const envPath = join(__dirname, "../../.env.local");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const [key, ...rest] = line.split("=");
    if (key && rest.length) process.env[key.trim()] = rest.join("=").trim();
  }
}
loadEnvLocal();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

interface TestCase {
  name: string;
  cols: number;
  rows: number;
  waitMs: number;
  /** What Gemini should check */
  prompt: string;
}

const TEST_CASES: TestCase[] = [
  {
    name: "standard-80x24",
    cols: 80,
    rows: 24,
    waitMs: 3500,
    prompt:
      "This is a terminal screenshot rendered in xterm.js at 80 columns. " +
      "Check: (1) Are ANSI colors displaying correctly (colored text visible, not raw escape codes like \\x1b[)? " +
      "(2) Is text readable without garbled characters (no â, ï, replacement chars)? " +
      "(3) Is there a visible progress bar (even if thin gaps exist between blocks)? " +
      "(4) Is there a visible table with columns? " +
      "Minor rendering artifacts like thin gaps between box-drawing characters are acceptable. " +
      "Reply with: PASS if the above criteria are met, or FAIL:<specific issue> only for serious problems like raw escape codes or garbled/missing content.",
  },
  {
    name: "wide-120x30",
    cols: 120,
    rows: 30,
    waitMs: 3500,
    prompt:
      "This is a terminal screenshot at 120 columns in xterm.js. " +
      "Check: (1) Does the header box span the full width without truncation? " +
      "(2) Are long text lines word-wrapped correctly within 120 columns? " +
      "(3) Are colors and unicode box-drawing characters rendered properly? " +
      "(4) Does the progress bar fill the correct width? " +
      "Reply with: PASS if everything looks correct, or FAIL:<reason> if something looks wrong.",
  },
  {
    name: "narrow-40x20",
    cols: 40,
    rows: 20,
    waitMs: 3500,
    prompt:
      "This is a terminal screenshot at only 40 columns in xterm.js. " +
      "NOTE: Some content (like tables designed for wider terminals) will legitimately " +
      "wrap at 40 characters — this is expected behavior, NOT a bug. " +
      "Check only: (1) Are ANSI colors displaying correctly (not showing raw escape codes like \\x1b[)? " +
      "(2) Is text readable (not garbled with replacement characters like â or ï)? " +
      "(3) Does the terminal show content at all (not blank/empty)? " +
      "Reply with: PASS if the above criteria are met, or FAIL:<specific issue> only if raw escape codes or garbled text is visible.",
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function waitForContent(page: Page, timeoutMs = 5000) {
  // Wait until xterm.js has received at least some output
  await page.waitForFunction(() => window._termReady, {
    timeout: timeoutMs,
  });
}

async function takeScreenshot(page: Page, name: string): Promise<{ path: string; base64: string }> {
  const path = join(SCREENSHOTS_DIR, `${name}.png`);
  const buffer = await page.screenshot({ path, fullPage: true });
  const base64 = buffer.toString("base64");
  return { path, base64 };
}

async function askGemini(imageBase64: string, prompt: string): Promise<string> {
  if (!GEMINI_API_KEY) {
    console.warn("GEMINI_API_KEY not set — skipping AI analysis");
    return "SKIP:no-api-key";
  }

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const imagePart: Part = {
    inlineData: {
      mimeType: "image/png",
      data: imageBase64,
    },
  };

  const result = await model.generateContent([imagePart, prompt]);
  const response = result.response;
  return response.text().trim();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("xterm.js PTY render UI tests", () => {
  let browser: Browser;
  let serverUrl: string;
  let serverClose: () => void;

  beforeAll(async () => {
    // Start the test server (serves xterm.js frontend + WebSocket PTY)
    const server = await startServer({
      cols: 120,
      rows: 30,
    });
    serverUrl = server.url;
    serverClose = server.close;

    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
    serverClose();
  });

  for (const tc of TEST_CASES) {
    it(`renders correctly at ${tc.cols}×${tc.rows} (${tc.name})`, async () => {
      const page = await browser.newPage();

      // Set viewport to fit the terminal plus some padding
      await page.setViewportSize({
        width: tc.cols * 8 + 80, // approx 8px per char + padding
        height: tc.rows * 18 + 120, // approx 18px per row + header
      });

      await page.goto(`${serverUrl}?cols=${tc.cols}&rows=${tc.rows}`);

      // Wait for web fonts to load
      await page.evaluate(() => document.fonts.ready);

      // Wait for xterm.js to be ready and output to arrive
      try {
        await waitForContent(page, 8000);
      } catch {
        console.warn(`Timeout waiting for content (${tc.name}) — continuing`);
      }

      // Wait a bit more for the mock CLI to produce all output
      await page.waitForTimeout(tc.waitMs);

      // Screenshot
      const { path, base64 } = await takeScreenshot(page, tc.name);
      console.log(`  Screenshot saved: ${path}`);

      // Ask Gemini
      const verdict = await askGemini(base64, tc.prompt);
      console.log(`  Gemini verdict (${tc.name}): ${verdict}`);

      // Save verdict alongside screenshot
      writeFileSync(path.replace(".png", ".verdict.txt"), verdict);

      await page.close();

      // Assert
      if (verdict.startsWith("SKIP:")) {
        console.warn(`  Skipping AI check: ${verdict}`);
        return;
      }

      expect(verdict.toUpperCase(), `Gemini found issues in ${tc.name}:\n${verdict}`).toMatch(
        /^PASS/i,
      );
    }, 90_000);
  }
});

// Allow running as a script too
declare global {
  interface Window {
    _term: unknown;
    _termReady: boolean;
  }
}
