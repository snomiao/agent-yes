import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// #453 made the PRODUCER declare a terminal wire (`raw: true`), because no
// byte-level predicate on the server may claim a keystroke or a mouse report —
// those shapes are indistinguishable from a short message. A declaration only
// works if every producer makes it, and #453 landed it on one of three: the
// other two kept flooding capacity-capped inboxes, where a mouse scrolled over
// a pane evicts the real messages behind it.
//
// So this is the guard the design needs: any `/api/send` write that declines to
// submit (`code: "none"`) is raw terminal input and must say so.
const ROOTS = ["ts", "lab/ui"];
const SKIP = new Set(["node_modules", "cf", "dist", "public"]);
const RAW_SEND = /code:\s*"none"/;

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|js)$/.test(e) && !/\.spec\./.test(e)) out.push(p);
  }
  return out;
}

/**
 * Call sites only — prose in a comment describing the protocol is not one.
 *
 * Line comments are stripped; block comments deliberately are not. Tracking
 * them needs a lexer, and getting it wrong wedges the scan silently. Prose
 * inside a block comment can only ever ADD a false offender, which fails
 * loudly and is fixed by rewording; it can never hide a real producer. The
 * count assertion below covers the opposite slip, a scan that stops matching.
 */
function callSites(file: string): { line: number; window: string }[] {
  const lines = readFileSync(file, "utf-8").split("\n");
  const hits: { line: number; window: string }[] = [];
  lines.forEach((raw, i) => {
    const code = raw.replace(/\/\/.*$/, "");
    if (RAW_SEND.test(code)) hits.push({ line: i + 1, window: code + (lines[i + 1] ?? "") });
  });
  return hits;
}

describe("every raw-input producer declares itself", () => {
  const files = ROOTS.flatMap((r) => sources(r));

  it('no /api/send call uses code:"none" without raw:true', () => {
    const offenders = files.flatMap((f) =>
      callSites(f)
        .filter((h) => !/raw:\s*true/.test(h.window))
        .map((h) => `${f}:${h.line}`),
    );
    expect(offenders).toEqual([]);
  });

  it("still finds the producers (a scan that matches nothing passes forever)", () => {
    const total = files.reduce((n, f) => n + callSites(f).length, 0);
    expect(total).toBeGreaterThanOrEqual(3);
  });
});
