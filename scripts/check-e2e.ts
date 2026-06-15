#!/usr/bin/env bun
// CI guard: the WebRTC DataChannel must ALWAYS be end-to-end encrypted. This
// fails the build if a plaintext-fallback pattern reappears in any of the three
// DataChannel handlers — a sealed channel that silently falls back to
// JSON.stringify/JSON.parse would defeat the whole protocol (see lab/ui/e2e.js).
//
// Note: signaling (the WebSocket) is plaintext by design — JSON.parse(ev.data)
// in a ws.onmessage handler is fine. We only forbid the DataChannel patterns.
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dir, "..");
const FILES = ["ts/share.ts", "lab/ui/share-host.ts", "lab/ui/index.html"];

// Literal substrings that only ever appear on a plaintext DataChannel path.
const FORBIDDEN = [
  "dc.send(JSON.stringify(",
  "this.dc.send(JSON.stringify(",
  "JSON.parse(ev2.data)", // browser dc.onmessage
  "onReq(dc, aborts, JSON.parse", // host dc.onmessage (old form)
];

let violations = 0;
for (const rel of FILES) {
  const src = readFileSync(path.join(root, rel), "utf8");
  for (const pat of FORBIDDEN) {
    if (src.includes(pat)) {
      console.error(`✗ ${rel}: forbidden plaintext-DataChannel pattern \`${pat}\``);
      violations++;
    }
  }
}

if (violations) {
  console.error(
    `\n${violations} plaintext-fallback pattern(s) found — DataChannel frames MUST go through seal()/open() in lab/ui/e2e.js.`,
  );
  process.exit(1);
}
console.log("✓ e2e: no plaintext-DataChannel fallback in", FILES.join(", "));
