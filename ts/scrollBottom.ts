/**
 * Scroll-to-bottom nudge (mirrors rs/src/context.rs scroll_bottom_check).
 *
 * claude's fullscreen mode can be scrolled (wheel / PgUp) away from the live
 * end of the transcript, hiding a yes/no menu that appears meanwhile — from the
 * human and from our own pattern matching. While scrolled up it shows a hint
 * (config `scrolledUp`). When that hint is on screen and the agent has been idle
 * for AGENT_YES_SCROLL_BOTTOM_IDLE_SECS (default 300, 0 disables), the runner
 * sends Ctrl+End once — claude's `scroll:bottom`, which leaves a menu's
 * selection alone (plain End moves it).
 */

/** xterm Ctrl+End (CSI 1;5F). */
export const CTRL_END = "\x1b[1;5F";
const DEFAULT_IDLE_SECS = 300;

export function scrollBottomIdleMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number.parseInt(env.AGENT_YES_SCROLL_BOTTOM_IDLE_SECS?.trim() ?? "", 10);
  return (Number.isFinite(n) && n >= 0 ? n : DEFAULT_IDLE_SECS) * 1000;
}

/** Scrolled up, idle long enough, and not the very screen we already nudged. */
export function shouldScrollBottom(
  scrolledUp: boolean,
  idleMs: number,
  limitMs: number,
  screen: string,
  lastSentScreen: string | null,
): boolean {
  return limitMs > 0 && scrolledUp && idleMs >= limitMs && screen !== lastSentScreen;
}
