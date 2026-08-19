/**
 * Guard for the one list in this repo that exists twice: the set of management
 * subcommands. `ts/subcommands.ts` owns the implementations; `rs/src/cli.rs`
 * keeps its own hardcoded copy purely to decide whether to re-exec the JS
 * launcher instead of treating the word as prompt text.
 *
 * Drift here fails SILENTLY and asymmetrically: a subcommand present only in
 * the TS list still works through the JS entry (`~/.bun/bin/ay`), so it looks
 * fine everywhere it is normally tested, while the same word typed at the
 * cargo-installed Rust binary is handed to the agent CLI as a prompt. Both
 * lists carry a "keep these in sync" comment; both have drifted anyway.
 *
 * So this file does not test behavior — it tests that the two source files
 * literally agree. They are parsed as TEXT rather than imported, because the
 * Rust side cannot be imported into vitest at all.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import path from "path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

/** String literals inside `const <name> = new Set([...])`. */
function tsList(source: string, name: string): string[] {
  const m = new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(source);
  if (!m) throw new Error(`could not find TS list ${name}`);
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

/** String literals inside `pub const <NAME>: &[&str] = &[...]`. */
function rsList(source: string, name: string): string[] {
  const m = new RegExp(`pub const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`).exec(source);
  if (!m) throw new Error(`could not find Rust list ${name}`);
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

describe("ts/subcommands.ts <-> rs/src/cli.rs subcommand mirror", () => {
  const ts = read("ts/subcommands.ts");
  const rs = read("rs/src/cli.rs");

  // Sanity-check the parsers themselves: a regex that silently matched nothing
  // would make every comparison below trivially pass on two empty arrays.
  it("parses a non-empty list out of each source file", () => {
    expect(tsList(ts, "SUBCOMMANDS").length).toBeGreaterThan(10);
    expect(rsList(rs, "SUBCOMMANDS").length).toBeGreaterThan(10);
    expect(tsList(ts, "MANAGER_SUBCOMMANDS").length).toBeGreaterThan(0);
    expect(rsList(rs, "MANAGER_SUBCOMMANDS").length).toBeGreaterThan(0);
  });

  // Compared as sorted sets: the Rust copy is a delegation gate, so only
  // membership matters — reordering either list for readability (or rustfmt
  // rewrapping the Rust one) must not fail this test.
  it("SUBCOMMANDS match", () => {
    expect([...rsList(rs, "SUBCOMMANDS")].sort()).toEqual([...tsList(ts, "SUBCOMMANDS")].sort());
  });

  it("MANAGER_SUBCOMMANDS match", () => {
    expect([...rsList(rs, "MANAGER_SUBCOMMANDS")].sort()).toEqual(
      [...tsList(ts, "MANAGER_SUBCOMMANDS")].sort(),
    );
  });

  // Catches the reverse drift: a word added to both lists (so the test above
  // passes) that no `case` ever handles would delegate from Rust into a JS
  // layer that then falls through to running an agent — the same bug, one
  // layer later.
  it("every subcommand has a dispatch case in ts/subcommands.ts", () => {
    const cases = new Set([...ts.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]!));
    const missing = [...tsList(ts, "SUBCOMMANDS"), ...tsList(ts, "MANAGER_SUBCOMMANDS")].filter(
      (name) => !cases.has(name),
    );
    expect(missing).toEqual([]);
  });
});
