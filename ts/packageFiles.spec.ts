import { readFileSync } from "fs";
import path from "path";
import picomatch from "picomatch";
import { describe, expect, it } from "vitest";

// `ay serve` (TS and ayrs) serves the console straight from the installed
// package's lab/ui. Anything the page loads but package.json "files" omits is a
// 404 in every npm install while working fine from a git checkout — e.g. a
// missing rtc.js fails the console's module graph and it never boots.
const root = path.join(import.meta.dirname, "..");
const ui = path.join(root, "lab", "ui");

function consoleAssets(): string[] {
  const refs = new Set<string>();
  for (const page of ["index.html", "sw.js"]) {
    const src = readFileSync(path.join(ui, page), "utf8");
    for (const m of src.matchAll(/["'](\.\/[\w./-]+\.(?:js|css|svg|webmanifest|html))["']/g))
      refs.add(path.posix.normalize(m[1]!));
  }
  return [...refs].sort();
}

describe("npm package files", () => {
  it("ships every asset the console loads", () => {
    const files: string[] = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).files;
    const isMatch = picomatch(files.filter((f) => !f.startsWith("!")));
    const assets = consoleAssets();
    expect(assets).toContain("rtc.js");
    expect(assets).toContain("vendor/xterm.min.js");
    expect(assets.filter((a) => !isMatch(`lab/ui/${a}`))).toEqual([]);
  });
});
