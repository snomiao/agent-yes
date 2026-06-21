#!/usr/bin/env bun
// Build + install the Rust binary.
//
// On Windows a running `agent-yes.exe` holds its own image file locked, so
// `cargo install` fails with "Access is denied" when it tries to remove/
// overwrite the old binary. Windows DOES permit *renaming* a running .exe
// (the live process keeps using the renamed image), so we move any locked
// binary aside as `agent-yes.old-<ts>.exe` before building and let cargo write
// a fresh one. This makes rebuilds lock-free without killing live sessions.
//
// On macOS/Linux a running binary can be replaced directly, so this is a no-op
// there and we just run cargo.
import { spawnSync } from "child_process";
import { existsSync, readdirSync, renameSync, rmSync } from "fs";
import os from "os";
import path from "path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), ".cargo");

// Both binaries cargo touches: the build output and the installed copy.
const targets = [
  path.join(repoRoot, "rs", "target", "release", "agent-yes.exe"),
  path.join(cargoHome, "bin", "agent-yes.exe"),
];

function moveLockedBinariesAside(): Array<{ original: string; aside: string }> {
  const moved: Array<{ original: string; aside: string }> = [];
  for (const exe of targets) {
    const dir = path.dirname(exe);
    if (!existsSync(dir)) continue;
    const base = path.basename(exe, ".exe");

    // Sweep stale .old- files from earlier rebuilds. Any still locked by a
    // live process will fail to delete — that's fine, skip and move on.
    for (const f of readdirSync(dir)) {
      if (f.startsWith(`${base}.old-`) && f.endsWith(".exe")) {
        try {
          rmSync(path.join(dir, f));
        } catch {
          /* still running — leave it */
        }
      }
    }

    // Move the current (possibly locked) binary aside so cargo can write fresh.
    if (existsSync(exe)) {
      const aside = path.join(dir, `${base}.old-${Date.now()}.exe`);
      try {
        renameSync(exe, aside);
        moved.push({ original: exe, aside });
        console.log(`[build-rs] moved locked binary aside: ${path.basename(aside)}`);
      } catch {
        // Not locked (or rename unsupported) — try a plain delete instead.
        try {
          rmSync(exe);
        } catch (e) {
          console.warn(`[build-rs] WARNING: could not free ${exe}: ${e}`);
        }
      }
    }
  }
  return moved;
}

const moved = process.platform === "win32" ? moveLockedBinariesAside() : [];

const args = ["install", "--path", "rs", "--features", "swarm", ...process.argv.slice(2)];
console.log(`[build-rs] cargo ${args.join(" ")}`);
const result = spawnSync("cargo", args, { cwd: repoRoot, stdio: "inherit" });

// On failure cargo never wrote the fresh originals, so restore anything we
// moved aside — otherwise a build error would leave agent-yes.exe missing
// from PATH until the next successful build.
if (result.status !== 0) {
  for (const { original, aside } of moved) {
    if (!existsSync(original) && existsSync(aside)) {
      try {
        renameSync(aside, original);
        console.warn(`[build-rs] build failed — restored ${path.basename(original)}`);
      } catch {
        /* best effort */
      }
    }
  }
}

process.exit(result.status ?? 1);
