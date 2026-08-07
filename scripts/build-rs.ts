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
import { copyFileSync, existsSync, readdirSync, renameSync, rmSync } from "fs";
import os from "os";
import path from "path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), ".cargo");

// Every binary cargo touches: the build output and the installed copy, for
// each [[bin]] in the package. Any of these can be locked by a live process,
// and cargo install refuses to overwrite an existing installed binary (even
// with --force it can't delete a locked one), so each must be moved aside.
const exeNames = ["agent-yes.exe", "ay-spawn-hidden.exe", "ayrs.exe"];
const targets = exeNames.flatMap((exe) => [
  path.join(repoRoot, "rs", "target", "release", exe),
  path.join(cargoHome, "bin", exe),
]);

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

// On a failed build cargo never wrote the fresh originals, so restore anything
// moveLockedBinariesAside() set aside — otherwise a build error leaves the .exe
// missing from PATH until the next successful build. Shared by both the default
// and the fast/dev paths.
function restoreMoved(): void {
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

// Dev-iteration fast paths. The default full build (release + full LTO +
// --features swarm) takes ~145s incremental — dominated by LTO relinking the
// whole webrtc binary every change (benchmarked; see docs/serve-rust-vs-ts-
// benchmark.md). These flags trade shipped-binary optimization for build speed:
//
//   --fast   ayrs-only, no swarm, LTO OFF  →  ~26s (5.6x). Still opt-level 3, so
//            the binary is a legit optimized console host — safe to actually run.
//   --dev    ayrs-only, no swarm, dev profile (opt0)  →  ~3s (48x). Unoptimized;
//            for rapid correctness iteration, NOT for a production host.
//
// Both build ONLY the `ayrs` bin (skips the ~65-crate libp2p tree that only the
// `agent-yes` P2P binary needs). CI / shipping uses the flagless full build.
const rawArgs = process.argv.slice(2);
const fast = rawArgs.includes("--fast");
const dev = rawArgs.includes("--dev");
const passthrough = rawArgs.filter((a) => a !== "--fast" && a !== "--dev");

// Fast dev paths use `cargo build` + copy, NOT `cargo install`: install builds in
// a temp target dir and can't reuse the rs/target incremental cache, so it rebuilds
// the whole graph (~110s) even when `cargo build` reuses the cache (~27s / ~3s).
if (fast || dev) {
  const env = { ...process.env } as Record<string, string>;
  // --manifest-path (not just --path like `cargo install`) so `cargo build` finds
  // the crate while cwd stays at repoRoot for the copy paths below.
  const buildArgs = ["build", "--manifest-path", path.join("rs", "Cargo.toml"), "--bin", "ayrs"]; // no swarm (ayrs doesn't use libp2p)
  if (!dev) {
    buildArgs.push("--release");
    env.CARGO_PROFILE_RELEASE_LTO = "false"; // the dominant incremental cost
  }
  buildArgs.push(...passthrough);
  console.log(
    `[build-rs] FAST dev build (${dev ? "dev/opt0" : "release/no-LTO"}, ayrs only, no swarm): cargo ${buildArgs.join(" ")}`,
  );
  const build = spawnSync("cargo", buildArgs, { cwd: repoRoot, stdio: "inherit", env });
  if (build.status === 0) {
    const exe = process.platform === "win32" ? "ayrs.exe" : "ayrs";
    const built = path.join(repoRoot, "rs", "target", dev ? "debug" : "release", exe);
    const dest = path.join(cargoHome, "bin", exe); // moveLockedBinariesAside already freed a locked dest on Windows
    // Copy to a temp name then rename over the dest: an in-place copy fails with
    // ETXTBSY when the dest binary is currently executing (e.g. `ayrs serve`
    // running under oxmgr), but an atomic rename replaces the name while the live
    // process keeps its old inode — the same trick `cargo install` uses.
    const tmp = `${dest}.new-${process.pid}`;
    copyFileSync(built, tmp);
    renameSync(tmp, dest);
    console.log(`[build-rs] installed ${dest}`);
    console.log(
      `[build-rs] NOTE: dev build — run \`bun run build:rs\` for the fully-optimized shipped binary`,
    );
  } else {
    // Build failed and cargo never wrote a fresh binary — restore anything the
    // Windows lock-aside moved, else ayrs.exe would be missing from PATH.
    restoreMoved();
  }
  process.exit(build.status ?? 1);
}

const args = ["install", "--path", "rs", "--features", "swarm", ...passthrough];
console.log(`[build-rs] cargo ${args.join(" ")}`);
const result = spawnSync("cargo", args, { cwd: repoRoot, stdio: "inherit" });

if (result.status !== 0) restoreMoved();

process.exit(result.status ?? 1);
