// Open a URL in the operator's default browser, gated behind an interactive
// prompt. Used after `ay serve --share` prints a WebRTC console link so the
// operator can jump straight into the console — but only when there's a real
// terminal to ask on AND a graphical session to open into, so SSH/CI/daemon
// runs never try to launch a browser they can't show (they just print the link).
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * The platform command that opens `url` in the default browser, or null when we
 * have no way to (a headless Linux box with no display). Pure — platform/env are
 * injectable so the resolution table is unit-testable.
 */
export function resolveOpener(
  url: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { cmd: string; args: string[] } | null {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  // `start` is a cmd builtin; the empty "" is its title arg so a URL with spaces
  // isn't mistaken for the window title.
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", url] };
  // Linux/BSD: opening a browser only makes sense inside a graphical session.
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
  return { cmd: "xdg-open", args: [url] };
}

/** Fire-and-forget launch of the browser. Returns false when we can't open. */
export function openInBrowser(url: string): boolean {
  const opener = resolveOpener(url);
  if (!opener) return false;
  try {
    const child = spawn(opener.cmd, opener.args, { stdio: "ignore", detached: true });
    child.on("error", () => {}); // missing opener binary → swallow, never crash the caller
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Offer to open `url` in the browser, defaulting to yes. No-ops silently unless
 * BOTH stdin/stdout are a TTY (so we can ask) AND a browser opener exists for
 * this platform (so "yes" can actually do something). Non-interactive contexts
 * — `curl | sh`, SSH, CI, the daemon — fall through and just leave the link
 * printed, as the operator chose.
 */
export async function offerOpenInBrowser(
  url: string,
  prompt = "Open in browser now? [Y/n] ",
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  if (!resolveOpener(url)) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (
      await new Promise<string>((resolve) => rl.question(prompt, resolve))
    )
      .trim()
      .toLowerCase();
    if (answer !== "" && answer !== "y" && answer !== "yes") return false;
  } finally {
    rl.close();
  }
  return openInBrowser(url);
}
