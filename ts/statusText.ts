/**
 * Extract a short "what is the agent doing right now?" line from the rendered
 * terminal screen. Claude Code paints this as a spinner/status line, e.g.
 * "✶ Verifying calendar meetings with real data… (6m 30s · ↓ 19.5k tokens)".
 */

const SPINNER_PREFIX = /^[\u2800-\u28ff✶✻✢✳✽✦✧✩✷✸✹✺✼·•●◐◓◒◑]\s+/u;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;

export function parseStatusText(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.replace(CONTROL, "").trim();
    if (!line || line.length < 3) continue;
    if (!SPINNER_PREFIX.test(line)) continue;
    if (/^(?:[•·]\s*)?(?:esc|ctrl|enter|return|shift|tab)\b/i.test(line)) continue;
    return line.slice(0, 220).trim();
  }
  return null;
}
